/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * users-census.d.ts: Type declarations for the official users census the webUI server reads.
 */
import type { AccessOfficialUser, OfficialApi } from "unifi-access";

/** The page size every read of the users listing asks for. */
export declare const USERS_PAGE_SIZE: number;

/**
 * The official users census, every page the endpoint answers in one list. A failure answers the empty list rather than throwing.
 *
 * @param official - The official API, or anything carrying its users listing.
 *
 * @returns Every user the endpoint listed, or none.
 */
export declare function officialUsers(official: { readonly users: Pick<OfficialApi["users"], "fetchAll"> }): Promise<AccessOfficialUser[]>;
