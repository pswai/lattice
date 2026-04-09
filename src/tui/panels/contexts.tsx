import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { ContextEntry } from '../../models/types.js';
import type { LatticeClient } from '../client.js';
import { useListNav } from '../hooks/use-list-nav.js';
import { colors, symbols, timeAgo, truncate } from '../theme.js';

interface ContextsPanelProps {
  client: LatticeClient;
  active: boolean;
  height: number;
}

export function ContextsPanel({ client, active, height }: ContextsPanelProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false); // Start NOT in search mode
  const [entries, setEntries] = useState<ContextEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [error, setError] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const listHeight = Math.max(1, height - 5);
  const { selectedIndex, scrollOffset } = useListNav(entries.length, listHeight, {
    enabled: active && !searching && pane === 'list',
  });

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setEntries([]);
      setTotal(0);
      return;
    }
    setSearchLoading(true);
    try {
      const result = await client.searchContext(q, { limit: 100 });
      setEntries(result.entries);
      setTotal(result.total);
      setError(null);
      setHasSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchLoading(false);
    }
  }, [client]);

  useInput((input, key) => {
    if (!active) return;

    if (searching) {
      if (key.return) {
        setSearching(false);
        doSearch(query);
        return;
      }
      if (key.escape) {
        setSearching(false);
        return;
      }
      if (key.backspace) {
        setQuery(prev => prev.slice(0, -1));
        return;
      }
      if (input && !key.escape) {
        setQuery(prev => prev + input);
        return;
      }
      return;
    }

    if (input === '/') { setSearching(true); return; }
    if (input === 'l' || key.rightArrow) setPane('detail');
    if (input === 'h' || key.leftArrow) setPane('list');
  });

  const selected = entries[selectedIndex] ?? null;
  const visibleEntries = entries.slice(scrollOffset, scrollOffset + listHeight);

  return (
    <Box flexDirection="row" height={height}>
      {/* List */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'list' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>KNOWLEDGE</Text>
          <Text color={colors.dim}> ({total})</Text>
          <Box flexGrow={1} />
          {entries.length > 0 && (
            <Text color={colors.dim}>{selectedIndex + 1}/{entries.length}</Text>
          )}
        </Box>

        <Box paddingX={1}>
          <Text color={colors.accent}>/</Text>
          {searching ? (
            <>
              <Text>{query}</Text>
              <Text color={colors.accent}>|</Text>
            </>
          ) : query ? (
            <Text color={colors.text}>{query}</Text>
          ) : (
            <Text color={colors.dim}> press / to search the knowledge base</Text>
          )}
        </Box>

        {searchLoading && (
          <Box paddingX={1}>
            <Text color={colors.accent}><Spinner type="dots" /></Text>
            <Text color={colors.dim}> Searching...</Text>
          </Box>
        )}

        {error && (
          <Box paddingX={1}>
            <Text color={colors.escalated}>{symbols.cross} {error}</Text>
          </Box>
        )}

        {visibleEntries.map((entry, i) => {
          const realIndex = scrollOffset + i;
          const isSelected = realIndex === selectedIndex;

          return (
            <Box key={entry.id} paddingX={1}>
              <Text color={isSelected ? colors.accent : colors.dim}>
                {isSelected ? symbols.selected : ' '}
              </Text>
              <Text color={isSelected ? colors.textBright : colors.text} bold>
                {' '}{truncate(entry.key, 25)}
              </Text>
              <Text color={colors.dim}> </Text>
              {entry.tags.slice(0, 3).map(tag => (
                <Text key={tag} color={colors.dim}>[{tag}]</Text>
              ))}
            </Box>
          );
        })}

        {!searchLoading && hasSearched && entries.length === 0 && (
          <Box paddingX={1}>
            <Text color={colors.dim}>No results for "{query}"</Text>
          </Box>
        )}
      </Box>

      {/* Detail */}
      <Box flexDirection="column" width="50%" borderStyle="single" borderColor={pane === 'detail' ? colors.accent : colors.border}>
        <Box paddingX={1}>
          <Text bold color={colors.accent}>DETAIL</Text>
        </Box>

        {selected ? (
          <Box flexDirection="column" paddingX={1}>
            <Box>
              <Text color={colors.dim}>Key:     </Text>
              <Text bold>{selected.key}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Tags:    </Text>
              <Text>{selected.tags.join(', ') || 'none'}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Author:  </Text>
              <Text>{selected.createdBy}</Text>
            </Box>
            <Box>
              <Text color={colors.dim}>Created: </Text>
              <Text>{timeAgo(selected.createdAt)}</Text>
            </Box>
            {selected.updatedAt && (
              <Box>
                <Text color={colors.dim}>Updated: </Text>
                <Text>{timeAgo(selected.updatedAt)}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text wrap="wrap">{selected.value}</Text>
            </Box>
          </Box>
        ) : (
          <Box paddingX={1}>
            <Text color={colors.dim}>Select an entry</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

export function contextsKeyHints(): Array<{ key: string; label: string }> {
  return [
    { key: '/', label: 'search' },
    { key: 'j/k', label: 'navigate' },
    { key: 'h/l', label: 'panes' },
  ];
}
