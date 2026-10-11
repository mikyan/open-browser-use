// Geometry is capture-time data in each document's own CSS viewport. It is not
// a top-frame hit-test result, visibility guarantee or instruction to scroll.
const fail = () => { throw new Error("OBU_SNAPSHOT_INCOMPLETE: invalid snapshot geometry"); };
const exact = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const finite = value => typeof value === "number" && Number.isFinite(value);
const validFrameId = value => value === "root" || typeof value === "string" && /^f([1-9]|[12][0-9]|3[0-2])$/.exec(value)?.[0] === value;
export const snapshotRefFrameId = ref => /^(f[1-9][0-9]*)e/.exec(ref)?.[1] ?? "root";

export function validateSnapshotGeometry(value, { refs, frameCount }) {
  if (!exact(value, ["coordinateSpace", "frames", "boxes"]) || value.coordinateSpace !== "frame-viewport-css" ||
      !Array.isArray(value.frames) || value.frames.length !== frameCount || frameCount < 1 || frameCount > 32 ||
      !Array.isArray(value.boxes) || value.boxes.length !== refs.length || refs.length > 2000) fail();
  const expected = new Set(refs), boxes = new Map(), frames = new Map(), owners = new Set();
  for (const item of value.boxes) {
    if (!exact(item, ["ref", "frameId", "box"]) || !expected.has(item.ref) || boxes.has(item.ref) ||
        !validFrameId(item.frameId) || snapshotRefFrameId(item.ref) !== item.frameId ||
        !exact(item.box, ["x", "y", "width", "height"]) || !Object.values(item.box).every(finite) ||
        item.box.width < 0 || item.box.height < 0) fail();
    boxes.set(item.ref, item);
  }
  for (const item of value.frames) {
    if (!exact(item, ["id", "parentId", "ownerRef", "viewport"]) || !validFrameId(item.id) || frames.has(item.id) ||
        !exact(item.viewport, ["width", "height", "scrollX", "scrollY", "devicePixelRatio"]) ||
        !Object.values(item.viewport).every(finite) || item.viewport.width < 0 || item.viewport.height < 0 ||
        item.viewport.devicePixelRatio <= 0) fail();
    if (!frames.size) {
      if (item.id !== "root" || item.parentId !== null || item.ownerRef !== null) fail();
    } else if (item.id === "root" || !frames.has(item.parentId) || owners.has(item.ownerRef) ||
        !boxes.has(item.ownerRef) || boxes.get(item.ownerRef).frameId !== item.parentId) fail();
    frames.set(item.id, item);
    if (item.ownerRef !== null) owners.add(item.ownerRef);
  }
  if ([...boxes.values()].some(item => !frames.has(item.frameId))) fail();
  return value;
}
