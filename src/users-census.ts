/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * users-census.ts: The official users census the webUI server reads its door guard labels from.
 */
import type { AccessOfficialUser, OfficialApi } from "unifi-access";

/* The census walk, in a module of its own rather than inside the server. The server instantiates its UI server class at import, so nothing can import that file
 * to exercise what lives in it; a walk that answers three different page shapes and swallows a failure is exactly the logic a suite should reach. The server
 * reads the compiled module from dist/, and the module imports types alone, so nothing the server loads through it reaches the HomeKit device graph.
 */

/** The page size every read of the users listing asks for, large enough that a typical site's census arrives in one round trip. */
export const USERS_PAGE_SIZE = 100;

/**
 * The official users census, every page the endpoint answers in one list. A failure answers the empty list rather than throwing.
 *
 * The census labels the door guard picker. The first page says how many there are - falling back to a single page when it reports no usable page size, so a zero
 * or missing value never divides into the total - and the rest are read together rather than one after another. The empty list stands in for the probe's failure
 * because the census only labels a picker: a token without the users permission still lists every device, and the guards those devices list carry their
 * identifiers as labels.
 *
 * @param official - The official API, or anything carrying its users listing.
 *
 * @returns Every user the endpoint listed, or none.
 */
export const officialUsers = async (official: { readonly users: Pick<OfficialApi["users"], "fetchAll"> }): Promise<AccessOfficialUser[]> => {

  try {

    const first = await official.users.fetchAll({ pageNum: 1, pageSize: USERS_PAGE_SIZE });
    const pagination = first.pagination;
    const pages = (pagination && (pagination.page_size > 0)) ? Math.ceil(pagination.total / pagination.page_size) : 1;
    const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) },
      (_, index) => official.users.fetchAll({ pageNum: index + 2, pageSize: USERS_PAGE_SIZE })));

    return [ ...first.data, ...rest.flatMap(page => page.data) ];
  } catch {

    // The census is a courtesy for the labels, and the device list never fails on its account.
    return [];
  }
};
