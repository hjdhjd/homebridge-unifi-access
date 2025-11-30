# Changelog since commit e41a3173

## Summary

This changelog documents all changes made to `homebridge-unifi-access` since commit `e41a3173b572b2eeb8a8283628d5b0d21eb8248b`.

**Files changed:** 7 files, +1750 insertions, -179 deletions

---

## New Features

### UA Gate Hub (UGT) Support

#### Side Door (Pedestrian Gate) Support
- Added full support for **side door/pedestrian gate** on UniFi Access Gate Hub (UGT) devices
- New feature option: `Hub.SideDoor` - enables a lock accessory for the side door (default: enabled)
- New feature option: `Hub.SideDoor.ServiceType` - configure the HomeKit service type for the side door:
  - `Lock` (default)
  - `GarageDoorOpener`
  - `Door`
- New feature option: `Hub.SideDoor.LockDelayInterval` - delay before auto-locking the side door
- New feature option: `Hub.SideDoor.Lock.Trigger` - add a switch accessory to control the side door lock
- New logging option: `Log.SideDoorLock` - log side door lock events

#### Door Service Type Configuration
- New feature option: `Hub.DoorServiceType` - configure the HomeKit service type for the **main door**:
  - `Lock` (default)
  - `GarageDoorOpener` - displays as a garage door with Open/Closed states
  - `Door` - displays as a door with position percentage

#### Door Position Sensor (DPS) for UA Gate
- Extended DPS support to include UA Gate devices
- UA Gate now supports the `Hub.DPS` feature option
- Added `"UA Gate"` to the list of models supporting DPS in feature options

---

## Technical Changes

### New WebSocket Event Handling

#### `access.data.v2.device.update` Events
- Added support for `location_states` array in device update events
- Each location state contains:
  - `location_id`: Door identifier
  - `lock`: Lock state (`"locked"` | `"unlocked"`)
  - `dps`: Door position (`"open"` | `"close"`)
  - `dps_connected`: DPS connection status
  - `enable`: Door enabled status
  - `is_unavailable`: Availability status

#### `access.data.v2.location.update` Events
- Added handler for location update events for real-time door state updates

### Door ID Discovery
- Implemented automatic discovery of main and side door IDs using multiple strategies:
  1. Device config bound door
  2. Name pattern matching (e.g., "portail", "main", "gate" for main door; "portillon", "side", "pedestrian" for side door)
  3. Port extension settings
  4. Fallback to first/second door

### Gate Transition Cooldown
- Added **5-second cooldown** after triggering a gate open/close action
- During cooldown, all DPS sensor updates are ignored to prevent rapid state bouncing
- This prevents the gate from immediately showing "Closed" when opening, as the sensor may bounce during movement

### State Initialization
- Initial door states are now loaded from the bootstrap data (doors list) instead of making additional API calls
- Fallback `fetchInitialDoorStates()` method retained but not called by default

### Private State Management
- Added private backing variable `_hkDpsState` for main door DPS state
- Added private backing variable `_hkSideDoorDpsState` for side door DPS state
- Added private backing variable `_hkSideDoorLockState` for side door lock state
- Modified `AccessHubHKProps` type to exclude `hkDpsState` from the mapped type (now implemented directly)

---

## New Reserved Names

Added to `AccessReservedNames` enum:
- `DOOR_MAIN` - Main door subtype identifier
- `DOOR_SIDE` - Side door subtype identifier  
- `LOCK_SIDE_DOOR` - Side door lock service subtype
- `SWITCH_SIDEDOOR_LOCK_TRIGGER` - Side door lock trigger switch subtype

---

## New Properties in AccessHub Class

```typescript
private _hkDpsState: CharacteristicValue;
private _hkSideDoorDpsState: CharacteristicValue;
private _hkSideDoorLockState: CharacteristicValue;
private doorServiceType: DoorServiceType;
private gateTransitionUntil: number;
private mainDoorLocationId: string | undefined;
private sideDoorLocationId: string | undefined;
private sideDoorGateTransitionUntil: number;
private sideDoorLockDelayInterval: number | undefined;
private sideDoorServiceType: DoorServiceType;
```

---

## New Methods in AccessHub Class

- `getDoorServiceType(option: string): DoorServiceType` - Parse door service type from config
- `discoverDoorIds(): void` - Discover main and side door location IDs
- `initializeDoorsFromBootstrap(doors): void` - Initialize states from bootstrap data
- `fetchInitialDoorStates(): Promise<void>` - Fetch states via API (fallback, not used by default)
- `fetchDoorState(doorId: string): Promise<boolean>` - Fetch single door state
- `configureGarageDoorService(service, isSideDoor): void` - Configure GarageDoorOpener service
- `configureDoorService(service, isSideDoor): void` - Configure Door service
- `configureLockService(service, isSideDoor): void` - Configure LockMechanism service
- `updateDoorServiceState(isSideDoor: boolean): void` - Update door service from DPS state
- `hubSideDoorLockCommand(isLocking: boolean): Promise<boolean>` - Execute side door lock/unlock

---

## New Hints

Added to `AccessHints`:
- `hasSideDoor` - Whether the device has a side door configured
- `logSideDoorLock` - Whether to log side door lock events

---

## Commits

1. `b4608b8` - feat: Add side door lock support for UA Gate devices
2. `287c624` - style: Improve code formatting and consistency in access-device and access-hub files
3. `8b387bb` - Merge pull request #1 from mickael-palma-wttj/add-side-door-to-access-hub (tag: v1.10.2)
4. `ea415fd` - feat: add side door lock support and logging for UniFi Access Gate Hub devices
5. `d4269cd` - style: Improve formatting of modelKey arrays in feature options for consistency
6. `d51b08a` - feat: enhance side door location retrieval logic for AccessHub
7. `8ad3517` - style: improve code formatting and consistency in access-hub.ts
8. `8f6148f` - feat: improve side door lookup logging by including primary door ID
9. `1fb4a05` - feat: enhance side door lookup logic with multiple strategies for improved accuracy
10. `de99939` - style: improve code formatting and consistency in access-hub.ts
11. `7acbaac` - feat: add support for configurable door service types for main and side doors
12. `506ed8a` - feat: add support for UA Gate in door position sensor features
13. `c8e857a` - feat: Implement code changes to enhance functionality and improve performance
