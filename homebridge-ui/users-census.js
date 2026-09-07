/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * users-census.js: The official users census the webUI server reads its door guard labels from.
 */
"use strict";

/* The census walk, in a module of its own beside the server rather than inside it. The server instantiates its UI server class at import, so nothing can import
 * that file to exercise what lives in it; a walk that answers three different page shapes and swallows a failure is exactly the logic a suite should reach. The
 * server imports this module and nothing else does.
 */

// The page the official users listing answers by, large enough that a typical site's census arrives in one round trip.
export const USERS_PAGE_SIZE = 100;

/* The official users census, every page the endpoint answers in one list, for labeling the door guard picker. The first page says how many there are, and the
 * rest are read together rather than one after another. A failure answers the empty list rather than the probe's failure: the census only labels a picker, so a
 * token without the users permission still lists every device, and the guards those devices list carry their identifiers as labels.
 */
export const officialUsers = async (official) => {

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
