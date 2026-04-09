import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

interface KeyHint {
  key: string;
  label: string;
}

interface FooterProps {
  bindings: KeyHint[];
  error?: string | null;
}

export function Footer({ bindings, error }: FooterProps) {
  return (
    <Box flexDirection="column">
      {error && (
        <Box paddingX={1}>
          <Text color={colors.escalated}>{error}</Text>
        </Box>
      )}
      <Box paddingX={1}>
        <Text>
          {bindings.map((b, i) => (
            <React.Fragment key={b.key}>
              {i > 0 && <Text color={colors.dim}>  </Text>}
              <Text bold color={colors.accent}>{b.key}</Text>
              <Text color={colors.dim}>:{b.label}</Text>
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
