/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.ts: The fixture builders more than one suite reads - the topology documents, the configuration rows, and the managed device records.
 *
 * Each export states one Access document or record shape, so every suite seeding that shape seeds the same one and a change to the shape is a change in one place.
 * A harness only one file reads stays in that file: the hub suite's real-HAP accessory, the device suite's write recorder, and the status feed's client stub are
 * instruments for one suite's questions rather than shared vocabulary, and moving them here would buy nothing.
 *
 * The record builders default to the members every suite that spells one agrees on, and to nothing beyond that. Overrides can add a member or restate one but
 * cannot take a defaulted member away, so a default carrying more than the agreed set would change what an arm reads in a suite that deliberately left that member
 * out. Everything past the agreed set is the calling suite's own override.
 *
 * The reduced device type requires members the agreed set does not carry, so each record builder asserts its literal onto that type directly. One assertion is
 * enough, because the type is a superset of the literal...nothing here needs the wider trip through unknown.
 *
 * Co-located under src/ so the type-check pass covers this file alongside everything else, while tsconfig.build.json excludes every *.helpers.ts from the emitted
 * dist/, so none of it reaches the published package.
 */
/* eslint-disable camelcase */
import type { AccessBootstrapConfig, AccessDeviceEntryConfig, AccessStateDevice } from "unifi-access";

/**
 * The building every topology document below roots at, and the location an Enterprise hub is recognized as building-hosted by.
 */
export const ROOT_ID = "root1";

/**
 * Build a minimal topology document carrying the given device records directly under the building, with no floors and no doors of its own.
 *
 * Only the members the library's reducer and its selectors read are meaningful; the rest satisfies the document's shape. Hardware hung straight off the building
 * serves no door, so a document from this builder establishes nothing about one.
 *
 * @param devices - The device records to place in the building's device group.
 *
 * @returns The topology document.
 */
export function buildingTopology(devices: Record<string, unknown>[]): AccessBootstrapConfig {

  return {

    device_groups: [devices],
    extra_type: "building",
    extras: {},
    floors: [],
    full_name: "Test Building",
    level: 0,
    location_type: "building",
    name: "Test Building",
    timezone: "UTC",
    unique_id: ROOT_ID,
    up_id: "",
    work_time: "",
    work_time_id: ""
  } as unknown as AccessBootstrapConfig;
}

/**
 * Build a minimal topology document whose doors each carry their own serving hardware, on a single floor under the building.
 *
 * The library resolves a door's serving hardware from that door's own device group, so this is the document any arm about door state has to seed: hardware placed
 * under a door serves that door and seeds what the door establishes.
 *
 * @param doors - Each door's identity, the device records serving it, and the name it carries. The name defaults to the identity in prose form, and a door's full
 *                name always reads the same as its name.
 *
 * @returns The topology document.
 */
export function doorsTopology(doors: { devices: Record<string, unknown>[]; id: string; name?: string }[]): AccessBootstrapConfig {

  return {

    device_groups: [[]],
    extra_type: "building",
    extras: {},
    floors: [{

      doors: doors.map(({ devices, id, name = "Door " + id }) => ({ device_groups: [devices], extras: {}, full_name: name, level: 2, location_type: "door", name,
        unique_id: id, up_id: "floor1" })),
      floor_number: 1,
      level: 1,
      name: "Test Floor",
      unique_id: "floor1",
      up_id: ROOT_ID
    }],
    full_name: "Test Building",
    level: 0,
    location_type: "building",
    name: "Test Building",
    timezone: "UTC",
    unique_id: ROOT_ID,
    up_id: "",
    work_time: "",
    work_time_id: ""
  } as unknown as AccessBootstrapConfig;
}

/**
 * Build the configuration rows a device record carries, in the key/tag/value shape the controller writes them as.
 *
 * @param options - deviceId: the device the rows are addressed to, defaulting to the identity the shared hub record carries; entries: the key each row is read by
 *                  and the reading it reports; tag: the family the rows belong to, defaulting to the terminal input readings.
 *
 * @returns One row per entry, in the order the entries were given.
 */
export function configRows({ deviceId = "device1", entries, tag = "input_state" }: { deviceId?: string; entries: Record<string, string>;
  tag?: string; }): AccessDeviceEntryConfig[] {

  return Object.entries(entries).map(([ key, value ]) => ({ device_id: deviceId, key, tag, value }));
}

/**
 * Build a managed hub record: the members every suite that seeds one agrees on, with whatever the calling arm cares about layered over them.
 *
 * @param overrides - The members to add to the record or to restate on it.
 *
 * @returns The record.
 */
export function hubRecord(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Test Hub", unique_id: "device1",
    ...overrides } as AccessStateDevice & { mac: string };
}

/**
 * Build a managed reader record: the members every suite that seeds one agrees on, with whatever the calling arm cares about layered over them. The hub a reader
 * hangs off is a caller's override, because a reader's own record says nothing about one until a suite asks it to.
 *
 * @param overrides - The members to add to the record or to restate on it.
 *
 * @returns The record.
 */
export function readerRecord(overrides: Record<string, unknown> = {}): AccessStateDevice & { mac: string } {

  return { capabilities: ["is_reader"], device_type: "UA-G2-PRO", is_managed: true, mac: "aabbccddee02", name: "Test Reader", unique_id: "reader1",
    ...overrides } as AccessStateDevice & { mac: string };
}
