/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing.helpers.test.ts: Tests for the shared fixture builders.
 *
 * A builder is code, and a defect in one would corrupt every arm that seeds a document or a record through it without any of them going red for a reason a reader
 * could trace. So each builder is held to what production code is held to: the populated set it answers with, the precedence an override takes over a default, and
 * a distinguishing input per arm that a builder ignoring the option could not coincide with.
 */
/* eslint-disable camelcase */
import type { AccessBootstrapConfig, AccessDoorConfig } from "unifi-access";
import { ROOT_ID, buildingTopology, configRows, doorsTopology, hubRecord, readerRecord } from "./testing.helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";

// The doors a topology document carries, reached the way the library's own door-state derivation reaches them: through the building's single floor.
function doorsOf(topology: AccessBootstrapConfig): AccessDoorConfig[] {

  return topology.floors?.[0]?.doors ?? [];
}

test("buildingTopology places every device it is handed in the building's own device group, under the shared root", () => {

  const devices = [ { unique_id: "device1" }, { unique_id: "device2" } ];
  const topology = buildingTopology(devices);

  // Two devices rather than one: a builder that took only the first, or that gave each device a group of its own, would read differently here.
  assert.deepEqual(topology.device_groups, [devices], "every device belongs to the building's one device group, in the order it was given");

  // A building document that grew a floor would seed doors nothing asked for, and the arms that read this shape are about hardware serving no door at all.
  assert.deepEqual(topology.floors, [], "a building document carries no floors");
  assert.equal(topology.unique_id, ROOT_ID, "the document roots at the shared building identity");
});

test("doorsTopology gives each door its own device group rather than one shared slot", () => {

  const first = [{ unique_id: "device1" }];
  const second = [{ unique_id: "device2" }];

  /* Two doors, with distinct identities and distinct device lists. A single door cannot tell a per-door map from a hardcoded slot: a builder that put every
   * device under the first door, or that gave both doors the same group, passes a one-door arm and fails this one.
   */
  const doors = doorsOf(doorsTopology([ { devices: first, id: "door1" }, { devices: second, id: "door2" } ]));

  assert.deepEqual(doors.map(door => door.unique_id), [ "door1", "door2" ], "each entry becomes its own door, in the order it was given");
  assert.deepEqual(doors[0]?.device_groups, [first], "the first door serves only the hardware handed to it");
  assert.deepEqual(doors[1]?.device_groups, [second], "and the second serves only its own");
});

test("doorsTopology names a door after its identity by default and carries a supplied name into both names a door has", () => {

  const doors = doorsOf(doorsTopology([ { devices: [], id: "door1" }, { devices: [], id: "door2", name: "Side Gate" } ]));

  assert.equal(doors[0]?.name, "Door door1", "a door with no name of its own is named after its identity");
  assert.equal(doors[0]?.full_name, "Door door1", "and its full name reads the same");

  // "Side Gate" is a spelling the default cannot produce, so a builder that ignored the option would read "Door door2" on both members below.
  assert.equal(doors[1]?.name, "Side Gate", "a supplied name is what the door carries");
  assert.equal(doors[1]?.full_name, "Side Gate", "and its full name reads the same");
});

test("configRows yields one row per entry, addressed to the default device under the default tag", () => {

  // The two entries report different readings, so a builder that carried one value onto every row would go red rather than coincide with the expectation.
  assert.deepEqual(configRows({ entries: { "input_state_rel": "on", "input_state_rex": "off" } }), [

    { device_id: "device1", key: "input_state_rel", tag: "input_state", value: "on" },
    { device_id: "device1", key: "input_state_rex", tag: "input_state", value: "off" }
  ], "each entry becomes one whole row, in the order it was given");
});

test("configRows honors a supplied device and tag on every row it yields", () => {

  /* The tag is deliberately something other than the default, so an assertion expecting it can never pass by coinciding with what the builder falls back to, and
   * the device identity is likewise not the one the shared hub record carries.
   */
  assert.deepEqual(configRows({ deviceId: "74acb9d55b9c", entries: { "wiring_state_rel-neg": "on", "wiring_state_rel-pos": "on" }, tag: "wiring" }), [

    { device_id: "74acb9d55b9c", key: "wiring_state_rel-neg", tag: "wiring", value: "on" },
    { device_id: "74acb9d55b9c", key: "wiring_state_rel-pos", tag: "wiring", value: "on" }
  ], "both options reach every row");
});

test("configRows yields nothing at all for an empty set of entries", () => {

  // Deep equality against an empty list rather than a length check: a builder answering a single row of undefined members has a length of one either way.
  assert.deepEqual(configRows({ entries: {} }), [], "a census that mentioned nothing is an empty row list");
});

test("hubRecord with no overrides carries exactly the members every suite that seeds one agrees on", () => {

  /* Whole-object equality rather than a member-by-member read. The point of the default is that it is the smallest set, so a default that carried one member more
   * would silently change what an arm reads in a suite that deliberately left that member out, and only a bounded comparison catches that.
   */
  assert.deepEqual(hubRecord(), { capabilities: ["is_hub"], device_type: "UAH", is_managed: true, mac: "aabbccddee01", name: "Test Hub",
    unique_id: "device1" }, "the shared hub default is the agreed set and nothing besides");
});

test("readerRecord with no overrides carries exactly the members every suite that seeds one agrees on", () => {

  assert.deepEqual(readerRecord(), { capabilities: ["is_reader"], device_type: "UA-G2-PRO", is_managed: true, mac: "aabbccddee02", name: "Test Reader",
    unique_id: "reader1" }, "the shared reader default is the agreed set and nothing besides");

  // Absence stated as precisely as presence: a reader that carried a hub identity by default would hang every suite's readers off a hub none of them named.
  assert.ok(!("connected_uah_id" in readerRecord()), "the hub a reader hangs off is a caller's override rather than a default");
});

test("an override restates a defaulted member's value rather than being buried under the default", () => {

  /* A spelling no default carries. A builder that spread its defaults over the overrides instead of under them would answer "Test Hub" and "Test Reader" here
   * while still carrying the right number of members, so a key count could not tell the two orders apart and a value read can.
   */
  assert.equal(hubRecord({ name: "Plain Hub" }).name, "Plain Hub", "the hub record reads the name it was handed");
  assert.equal(readerRecord({ name: "Side Reader" }).name, "Side Reader", "and the reader record reads its own");
});

test("an override for a member no default carries lands on the record as a new member", () => {

  const hub = hubRecord({ connected_uah_id: "device1" });

  assert.equal(hub.connected_uah_id, "device1", "a member outside the agreed set is added rather than dropped");
  assert.equal(hub.name, "Test Hub", "and the members the default does carry are left where they were");
});

test("every call builds its own document and record, so no two callers share nested state", () => {

  const records = [ hubRecord(), hubRecord() ];
  const topologies = [ buildingTopology([]), buildingTopology([]) ];

  /* Reference inequality, which is what a module-level default spread into every result would fail. Two callers holding one array is the defect that would let an
   * arm mutating its own fixture move a fixture in a file it never reads.
   */
  assert.notEqual(records[0]?.capabilities, records[1]?.capabilities, "two records must not share one capabilities array");
  assert.notEqual(topologies[0]?.device_groups, topologies[1]?.device_groups, "and two documents must not share one device group");
});
