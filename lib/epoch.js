/**
 * One epoch per plugin instance, shared across HMR module evaluations.
 *
 * A reload can leave the previous engine's press mid-await. Without a generation marker that old
 * press must not overwrite the plan the new instance wrote. The marker lives on `globalThis`, so a
 * re-evaluated module sees the same counter, and every write checks it.
 */

const KEY = Symbol.for('dsh-pause-resume.epoch')

export function nextEpoch() {
  const holder = globalThis
  const value = Number.isSafeInteger(holder[KEY]) ? holder[KEY] : 0
  holder[KEY] = value + 1
  return holder[KEY]
}

export function currentEpoch() {
  const value = globalThis[KEY]
  return Number.isSafeInteger(value) ? value : 0
}

/** A disposed instance invalidates its own epoch, so its in-flight writes become no-ops. */
export function dropEpoch(epoch) {
  if (currentEpoch() !== epoch) return
  nextEpoch()
}
