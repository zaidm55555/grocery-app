import type { TestInstance } from 'test-renderer';

// RNTL 14 renders through Test Renderer, which exposes host elements only, so
// `UNSAFE_getAllByType(TouchableOpacity)` is gone. A TouchableOpacity renders as a
// host View carrying its press handlers (and its `hitSlop`/`style`), so match that.
export const isTouchable = (n: TestInstance) => n.type === 'View' && typeof n.props.onClick === 'function';

/** Touchables below `root` (not `root` itself), in render order. */
export const touchablesIn = (root: TestInstance) => root.queryAll(isTouchable);
