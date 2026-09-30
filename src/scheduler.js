const MARKS = [0, 20, 40];

export function nextMark(from = new Date()) {
  const next = new Date(from);
  next.setSeconds(0, 0);
  const upcoming = MARKS.find((m) => m > from.getMinutes());
  if (upcoming !== undefined) {
    next.setMinutes(upcoming);
  } else {
    next.setHours(next.getHours() + 1);
    next.setMinutes(0);
  }
  return next;
}

// Recomputes the delay to the next :00/:20/:40 mark on every fire instead of
// a fixed setInterval(20 * 60_000, ...), so it can't drift off the mark over
// a long-running process.
// +1s slop: Node timers can fire up to ~1ms early, which right at a boundary
// (e.g. 12:19:59.999) would make nextMark() return the mark we're already
// firing for, giving a near-zero timeout and a double fire.
function delayToNextMark() {
  return nextMark(new Date(Date.now() + 1000)).getTime() - Date.now();
}

export function scheduleEvery20(fn) {
  function tick() {
    Promise.resolve(fn()).catch((err) => console.error('scheduled check failed:', err));
    setTimeout(tick, delayToNextMark());
  }
  setTimeout(tick, delayToNextMark());
}
