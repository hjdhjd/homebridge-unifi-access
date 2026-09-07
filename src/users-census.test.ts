/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * users-census.test.ts: Tests for the official users census the webUI server labels its door guard picker from.
 *
 * The walk answers three page shapes - a listing that fits in one page, one that spans several, and one the endpoint reports no pagination for - and it answers a
 * failure with the empty list rather than the failure. Each is an arm below, driven through a fake that records every read it was asked for, so what a page shape
 * costs in round trips is read rather than assumed.
 *
 * The fake settles its later pages before its earlier ones. The rest of the pages are read together, so nothing about the assembled order may depend on which of
 * them came back first, and staggering them is what makes the page-order assertion a proof rather than an agreement with the order the reads happened to complete in.
 */
/* eslint-disable camelcase */
import type { AccessOfficialResult, AccessOfficialUser, AccessOfficialUserListOptions } from "unifi-access";
import { USERS_PAGE_SIZE, officialUsers } from "../homebridge-ui/users-census.js";
import assert from "node:assert/strict";
import test from "node:test";

// What a page answers when the walk reads it: the result the read resolves with, or the error it throws.
type CensusPage = AccessOfficialResult<AccessOfficialUser[]> | Error;

// A stood-up census and what it recorded: the official surface the walk reads, and every read it was asked for, in the order the reads were made.
interface CensusFake {

  official: { readonly users: { fetchAll: (opts?: AccessOfficialUserListOptions) => Promise<AccessOfficialResult<AccessOfficialUser[]>> } };
  reads: { pageNum?: number; pageSize?: number }[];
}

/* One user as the endpoint lists them, reduced to the identifier an arm reads it back by. The walk reads none of a user's own members - it concatenates whatever
 * each page carried - so an identifier is the whole of what a fixture needs, and the cast is this file's statement that the rest of the record is beside the point.
 *
 * @param id - The identifier the arm recognizes this user by.
 *
 * @returns The user record.
 */
function user(id: string): AccessOfficialUser {

  return { id } as unknown as AccessOfficialUser;
}

/* Wait the given number of microtask turns. Each turn is one link in an already-resolved chain rather than a timer, so a page settles behind its siblings without
 * anything having to advance a clock.
 *
 * @param count - How many turns to wait.
 */
async function turns(count: number): Promise<void> {

  let settled = Promise.resolve();

  for(let turn = count; turn > 0; turn--) {

    settled = settled.then((): void => undefined);
  }

  await settled;
}

/* A fake official API answering the users listing from the pages an arm states, in page order: the first entry is page one, and a page the walk never reaches is
 * one the arm never states.
 *
 * A page carrying an error throws it, which is how a listing that fails partway is expressed. Every page waits a number of microtask turns that runs opposite to its
 * page number, so the last page settles first and the assembled order is proved rather than inherited from the order the reads completed in.
 *
 * @param pages - What each page answers, in page order.
 *
 * @returns The official surface to hand the walk, and the reads it records.
 */
function census(pages: CensusPage[]): CensusFake {

  const reads: { pageNum?: number; pageSize?: number }[] = [];

  return {

    official: {

      users: {

        fetchAll: async (opts?: AccessOfficialUserListOptions): Promise<AccessOfficialResult<AccessOfficialUser[]>> => {

          reads.push({ pageNum: opts?.pageNum, pageSize: opts?.pageSize });

          const pageNum = opts?.pageNum ?? 0;

          await turns(pages.length - pageNum);

          const answer = pages[pageNum - 1];

          assert.ok(answer, "the arm must state an answer for every page the walk reads, and page " + pageNum.toString() + " has none");

          if(answer instanceof Error) {

            throw answer;
          }

          return answer;
        }
      }
    },
    reads
  };
}

test("a census whose first page says it is the only page reads once and answers it", async () => {

  const users = [ user("first"), user("second") ];
  const fake = census([{ data: users, pagination: { page_num: 1, page_size: USERS_PAGE_SIZE, total: 2 } }]);

  assert.deepEqual(await officialUsers(fake.official), users, "a total that fits inside one page is the page itself");
  assert.deepEqual(fake.reads, [{ pageNum: 1, pageSize: USERS_PAGE_SIZE }], "read exactly once, at the page size the walk asks by");
});

test("a census spanning several pages reads the rest together and answers them in page order", async () => {

  const fake = census([ { data: [user("page1")], pagination: { page_num: 1, page_size: USERS_PAGE_SIZE, total: 250 } }, { data: [user("page2")] },
    { data: [user("page3")] } ]);
  const answered = await officialUsers(fake.official);

  assert.deepEqual(fake.reads, [ { pageNum: 1, pageSize: USERS_PAGE_SIZE }, { pageNum: 2, pageSize: USERS_PAGE_SIZE },
    { pageNum: 3, pageSize: USERS_PAGE_SIZE } ], "a total of 250 at a page size of 100 is three pages, each asked for at that size");
  assert.deepEqual(answered.map(entry => entry.id), [ "page1", "page2", "page3" ],
    "and the answer is the pages concatenated in page order, which the last page settling first is what proves");
});

test("a census answering no pagination is one page", async () => {

  const users = [user("only")];
  const fake = census([{ data: users }]);

  assert.deepEqual(await officialUsers(fake.official), users, "an endpoint that reported no pagination answered everything it has");
  assert.deepEqual(fake.reads, [{ pageNum: 1, pageSize: USERS_PAGE_SIZE }], "so nothing beyond the first page is asked for");
});

test("a census whose first read throws answers no users", async () => {

  const fake = census([new Error("The token cannot list users.")]);

  assert.deepEqual(await officialUsers(fake.official), [], "a listing that failed is no users rather than a failure the caller has to handle");
  assert.equal(fake.reads.length, 1, "and a first read that threw says nothing about how many pages there are, so no second read is made");
});

test("a census whose later page throws answers no users rather than a partial list", async () => {

  const fake = census([ { data: [user("page1")], pagination: { page_num: 1, page_size: USERS_PAGE_SIZE, total: 200 } },
    new Error("The listing went away mid-census.") ]);

  assert.deepEqual(await officialUsers(fake.official), [], "a census that could not be completed is answered as none rather than as the pages that did arrive");
  assert.equal(fake.reads.length, 2, "and both pages were genuinely asked for, which is what makes the failure a partial one");
});
