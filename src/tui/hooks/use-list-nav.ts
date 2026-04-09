import { useState, useCallback, useEffect, useRef } from 'react';
import { useInput } from 'ink';

/**
 * Vim-style list navigation (j/k or arrows).
 * Returns selected index and scroll offset for viewport rendering.
 */
export function useListNav(
  itemCount: number,
  viewportHeight: number,
  opts?: { enabled?: boolean; onSelect?: (index: number) => void },
): {
  selectedIndex: number;
  scrollOffset: number;
  setSelectedIndex: (i: number) => void;
} {
  const [selectedIndex, setSelectedIndexState] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const enabled = opts?.enabled ?? true;
  const scrollRef = useRef(scrollOffset);
  scrollRef.current = scrollOffset;

  // Clamp when item count changes
  useEffect(() => {
    if (itemCount === 0) {
      setSelectedIndexState(0);
      setScrollOffset(0);
      return;
    }
    if (selectedIndex >= itemCount) {
      setSelectedIndexState(itemCount - 1);
    }
  }, [itemCount, selectedIndex]);

  const adjustScroll = useCallback((newIndex: number) => {
    if (newIndex < scrollRef.current) {
      setScrollOffset(newIndex);
    } else if (newIndex >= scrollRef.current + viewportHeight) {
      setScrollOffset(newIndex - viewportHeight + 1);
    }
  }, [viewportHeight]);

  useInput((input, key) => {
    if (!enabled || itemCount === 0) return;

    let newIndex = selectedIndex;

    if (input === 'j' || key.downArrow) {
      newIndex = Math.min(selectedIndex + 1, itemCount - 1);
    } else if (input === 'k' || key.upArrow) {
      newIndex = Math.max(selectedIndex - 1, 0);
    } else if (input === 'g') {
      newIndex = 0;
    } else if (input === 'G') {
      newIndex = itemCount - 1;
    } else if (key.return && opts?.onSelect) {
      opts.onSelect(selectedIndex);
      return;
    } else {
      return;
    }

    setSelectedIndexState(newIndex);
    adjustScroll(newIndex);
  });

  const setSelectedIndex = useCallback((i: number) => {
    setSelectedIndexState(i);
    adjustScroll(i);
  }, [adjustScroll]);

  return { selectedIndex, scrollOffset, setSelectedIndex };
}
