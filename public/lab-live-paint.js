/**
 * Progressive paint: the live board paints on board + danger-model;
 * the /api/exposure weight only re-sizes the footer cash chip when it lands. `isCurrent` = lab.js's fetchGen guard.
 */
export async function paintLive({ data, dmReady, expReady, isCurrent, paintBoard, paintFoot }) {
  await dmReady;
  if (!isCurrent()) return;
  paintBoard(data);
  void expReady.then(() => {
    if (isCurrent()) paintFoot();
  });
}
