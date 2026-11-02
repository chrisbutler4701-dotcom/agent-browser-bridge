const PREFIX = 'fbb-frame:';

export function scopeFrameRef(frameId, ref) {
  return frameId === 0 ? ref : `${PREFIX}${frameId}::${ref}`;
}

export function parseFrameTarget(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return { frameId: 0, value };
  const match = /^fbb-frame:(\d+)::(.+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) === 0) throw new Error('Invalid frame-scoped target.');
  return { frameId: Number(match[1]), value: match[2] };
}
