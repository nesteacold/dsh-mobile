// UI ported from Clarklevis1995/dsh-mobile
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownText.kt
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownCodeCard.kt
//   androidApp/src/main/kotlin/com/clarklevis/dsh/android/ui/DshMarkdownTable.kt   (MIT)
//
// The transcript's markdown renderer.
//
// WHAT IS PORTED, AND WHAT IS NOT: upstream renders markdown through Markwon and then paints
// spans; their code card shows an uppercase language label above a numbered, monospace block, and
// their table card is a bordered grid that scrolls horizontally. Compose spans have no RN
// equivalent, so this file rebuilds the *look* on `parse.ts`'s block tree with plain Views/Text -
// native only, no WebView (spec 011 non-negotiable), and no markdown dependency.
//
// Every colour, size and radius comes from `src/ui/theme.ts`; a hex literal here would be a bug.
// Links never open by themselves: the press is handed to `onOpenLink`, and the screen asks the
// user before anything leaves the app.

import { memo, useMemo, useState } from 'react';
import { Modal, Platform, ScrollView, Share, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';

import { useTheme } from '../theme';
import {
  codeLines,
  inlineText,
  parseMarkdown,
  type Align,
  type Block,
  type Inline,
  type ListBlock,
  type TableBlock,
  type TableCell,
} from './parse';

export interface MarkdownProps {
  /** Raw assistant markdown from the Host (untrusted). */
  source: string;
  /** Called when a link is tapped; the screen owns the confirmation dialog. */
  onOpenLink?: (href: string, label: string) => void;
  /**
   * Wave-1 actions on a fenced code block: copy its text (Share until the native clipboard lands)
   * and, for tables, open the full-screen preview. Defaults keep the component usable standalone.
   */
  labels?: {
    share?: string;
    expand?: string;
    close?: string;
  };
}

/** Render one assistant message. Parsing is memoised per source string. */
export const Markdown = memo(function Markdown({ source, onOpenLink, labels }: MarkdownProps) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  if (blocks.length === 0) return null;

  return (
    <View style={{ gap: theme.space.sm }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} theme={theme} onOpenLink={onOpenLink} labels={labels} />
      ))}
    </View>
  );
});

type Theme = ReturnType<typeof useTheme>;

function BlockView({
  block,
  theme,
  onOpenLink,
  labels,
}: {
  block: Block;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  labels?: MarkdownProps['labels'];
}) {
  const { colors, type, space, radius } = theme;

  switch (block.kind) {
    case 'heading': {
      const style =
        block.level <= 1 ? type.title : block.level === 2 ? type.heading : type.subheading;
      return (
        <Text style={[style, { marginTop: space.sm }]} selectable>
          <Inlines inlines={block.inlines} theme={theme} onOpenLink={onOpenLink} />
        </Text>
      );
    }
    case 'paragraph':
      // Soft line breaks survive as newlines, which is what Clarklevis's SoftBreakAddsNewLine
      // plugin does upstream.
      return (
        <Text style={type.body} selectable>
          <Inlines inlines={block.inlines} theme={theme} onOpenLink={onOpenLink} />
        </Text>
      );
    case 'code':
      return <CodeCard block={block} theme={theme} labels={labels} />;
    case 'list':
      return <ListBlockView block={block} theme={theme} onOpenLink={onOpenLink} depth={0} labels={labels} />;
    case 'table':
      return <TableCard block={block} theme={theme} onOpenLink={onOpenLink} labels={labels} />;
    case 'rule':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: space.sm }} />;
    default:
      return null;
  }
}

/** Inline spans as nested `<Text>`s so formatting composes inside one paragraph. */
function Inlines({
  inlines,
  theme,
  onOpenLink,
}: {
  inlines: Inline[];
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
}) {
  const { colors, type, radius, space } = theme;
  return (
    <>
      {inlines.map((inline, index) => {
        switch (inline.kind) {
          case 'strong':
            return (
              <Text key={index} style={{ fontWeight: '600' }}>
                {inline.text}
              </Text>
            );
          case 'em':
            return (
              <Text key={index} style={{ fontStyle: 'italic' }}>
                {inline.text}
              </Text>
            );
          case 'code':
            // Their inline code is a small rounded chip on the code background.
            return (
              <Text
                key={index}
                style={[
                  type.mono,
                  {
                    backgroundColor: colors.codeBg,
                    borderRadius: radius.sm,
                    paddingHorizontal: space.xs,
                    color: colors.text,
                  },
                ]}
              >
                {inline.text}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={index}
                accessibilityRole="link"
                accessibilityLabel={inline.text}
                onPress={onOpenLink ? () => onOpenLink(inline.href, inline.text) : undefined}
                style={{ color: colors.accent, textDecorationLine: 'underline' }}
              >
                {inline.text}
              </Text>
            );
          default:
            return <Text key={index}>{inline.text}</Text>;
        }
      })}
    </>
  );
}

/**
 * Their code card: language label, then a horizontally scrollable, line-numbered monospace body.
 * Line numbers come from `codeLines`, so a trailing blank line in the fence is not numbered.
 */
function CodeCard({
  block,
  theme,
  labels,
}: {
  block: Extract<Block, { kind: 'code' }>;
  theme: Theme;
  labels?: MarkdownProps['labels'];
}) {
  const { colors, type, space, radius } = theme;
  const lines = codeLines(block.text);
  const gutterWidth = Math.max(1, String(lines.length).length) * 8 + space.sm;

  return (
    <View style={{ backgroundColor: colors.codeBg, borderRadius: radius.md, overflow: 'hidden' }}>
      {/* Wave 1 (DshMarkdownCodeCard.kt): the card's chrome carries the language AND a copy action.
          The system clipboard needs the native module that lands with the gradle build, so today the
          action hands the text to the OS Share sheet — the same practical outcome, no new native
          dependency in a bundle-swap build. */}
      <View style={[styles.codeHeader, { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm }]}>
        <Text
          style={[
            type.captionSmall,
            { color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase', flex: 1 },
          ]}
          numberOfLines={1}
        >
          {block.language ?? ''}
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={labels?.share ?? 'Share'}
          testID="markdown-code-share"
          hitSlop={8}
          onPress={() => {
            void Share.share({ message: block.text }).catch(() => {
              /* sheet dismissed or unavailable */
            });
          }}
          style={styles.codeAction}
        >
          <Text style={[type.captionSmall, { color: colors.accent }]}>⤴ {labels?.share ?? 'Share'}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
        <View style={{ flexDirection: 'row', padding: space.md, gap: space.sm }}>
          <View style={{ width: gutterWidth, alignItems: 'flex-end' }}>
            {lines.map((_, index) => (
              <Text key={index} style={[type.mono, { color: colors.textFaint }]}>
                {index + 1}
              </Text>
            ))}
          </View>
          <View>
            {lines.length === 0 ? (
              <Text style={[type.mono, { color: colors.textMuted }]}> </Text>
            ) : (
              lines.map((line, index) => (
                <Text key={index} style={type.mono} selectable>
                  {line === '' ? ' ' : line}
                </Text>
              ))
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Bullet/number rows with nesting indent; their lists are marker + text, not a separate bullet view. */
function ListBlockView({
  block,
  theme,
  onOpenLink,
  depth,
  labels,
}: {
  block: ListBlock;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  depth: number;
  labels?: MarkdownProps['labels'];
}) {
  const { colors, type, space } = theme;
  return (
    <View style={{ paddingLeft: depth === 0 ? 0 : space.lg, gap: space.xxs }}>
      {block.items.map((item, index) => (
        <View key={index} style={{ flexDirection: 'row', gap: space.sm }}>
          <Text style={[type.body, { color: colors.textMuted, minWidth: 18 }]}>
            {block.ordered ? `${block.start + index}.` : '•'}
          </Text>
          <View style={{ flex: 1, gap: space.xs }}>
            {item.blocks.map((child, childIndex) =>
              child.kind === 'list' ? (
                <ListBlockView
                  key={childIndex}
                  block={child}
                  theme={theme}
                  onOpenLink={onOpenLink}
                  depth={depth + 1}
                />
              ) : child.kind === 'code' ? (
                <CodeCard key={childIndex} block={child} theme={theme} />
              ) : child.kind === 'paragraph' ? (
                <Text key={childIndex} style={type.body} selectable>
                  <Inlines inlines={child.inlines} theme={theme} onOpenLink={onOpenLink} />
                </Text>
              ) : (
                <BlockView key={childIndex} block={child} theme={theme} onOpenLink={onOpenLink} labels={labels} />
              ),
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * One shared column grid for the whole table (reference 04).
 *
 * WHY: each cell used to be `minWidth: 120, maxWidth: 260` with no width of its own, so every row
 * sized its cells to its OWN text and the columns staggered down the card (measured on device: the
 * "Bản"/"Dòng"/"Trên GitHub" header did not line up with the row values under it). A markdown table
 * is a grid, so the width has to be decided once, for the column, and reused by every row.
 *
 * No layout engine is available to measure text before render, so the width comes from the longest
 * cell in the column times an average advance width, clamped and then shared.
 */
const CELL_CHAR_PX = 7.4;
const MIN_COLUMN_WIDTH = 88;
const MAX_COLUMN_WIDTH = 260;

/** Plain text of a cell, for width measurement only (the renderer still draws the inlines). */
function cellText(cell: TableCell): string {
  return cell.map((part) => inlineText(part)).join('');
}

/**
 * Width of every column: the longest cell in that column over header AND all rows.
 *
 * `available` is the width the table may occupy on screen. Measured defect: with three columns the
 * per-column maxima summed past the viewport, so the table scrolled horizontally and the LAST column
 * (the one the reference shows) was off-screen — the answer read as "Name | Role" only. So when the
 * measured widths overflow, every column is scaled down proportionally (`MIN_COLUMN_WIDTH` floor)
 * so the whole grid is visible without a horizontal drag; a single column that is still too wide
 * scrolls, which is what the full-screen preview is for.
 */
export function columnWidths(block: TableBlock, padding: number, available: number): number[] {
  const columns = block.header.length;
  const measured: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    let longest = 0;
    for (const row of [block.header, ...block.rows]) {
      const cell = row[column];
      if (cell === undefined) continue;
      const length = cellText(cell).length;
      if (length > longest) longest = length;
    }
    const width = Math.round(longest * CELL_CHAR_PX) + padding * 2;
    measured.push(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
  }
  const total = measured.reduce((sum, width) => sum + width, 0);
  if (total <= available || columns === 0) return measured;
  // Scale to fit, never below the floor; the grid then stays a grid and every column is readable.
  const scale = available / total;
  return measured.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.floor(width * scale)));
}

/** Their table card: a bordered grid that scrolls horizontally (reference: conversation-dark-mode). */
function TableCard({
  block,
  theme,
  onOpenLink,
  labels,
}: {
  block: TableBlock;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  labels?: MarkdownProps['labels'];
}) {
  const { colors, type, space, radius } = theme;
  const [expanded, setExpanded] = useState(false);
  const window = useWindowDimensions();
  const alignOf = (index: number): 'left' | 'center' | 'right' => {
    const value: Align = block.align[index] ?? null;
    return value ?? 'left';
  };
  // The conversation insets the transcript by `space.lg` on both sides; the assistant column adds a
  // little more, so the usable grid width is the window minus that gutter.
  const widths = columnWidths(block, space.md, Math.max(240, window.width - space.lg * 2));

  // One grid definition, reused by the inline card and the full-screen preview, so the two cannot
  // disagree about a column's width.
  const grid = (
    <View
      style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' }}
    >
      <Row cells={block.header} header theme={theme} onOpenLink={onOpenLink} alignOf={alignOf} widths={widths} />
      {block.rows.map((row, index) => (
        <Row key={index} cells={row} theme={theme} onOpenLink={onOpenLink} alignOf={alignOf} widths={widths} />
      ))}
    </View>
  );

  return (
    <View style={{ gap: space.xxs }}>
      {/* Wave 1 (DshMarkdownTable.kt DshMarkdownTablePreview): a wide table is unreadable inline, so
          the card offers a full-screen preview that scrolls in BOTH directions. */}
      <View style={[styles.codeHeader, { gap: space.sm }]}>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={labels?.expand ?? 'Expand table'}
          testID="markdown-table-expand"
          hitSlop={8}
          onPress={() => setExpanded(true)}
          style={styles.codeAction}
        >
          <Text style={[type.captionSmall, { color: colors.accent }]}>⤢ {labels?.expand ?? 'Expand'}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator bounces={false}>
        {grid}
      </ScrollView>
      <Modal visible={expanded} transparent animationType="fade" onRequestClose={() => setExpanded(false)}>
        <View style={[styles.fullscreen, { backgroundColor: colors.overlay }]}>
          <View style={[styles.fullscreenCard, { backgroundColor: colors.bg, borderRadius: radius.md }]}>
            <View style={[styles.codeHeader, { paddingHorizontal: space.md, paddingTop: space.sm }]}>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={labels?.close ?? 'Close'}
                testID="markdown-table-close"
                hitSlop={8}
                onPress={() => setExpanded(false)}
                style={styles.codeAction}
              >
                <Text style={[type.heading, { color: colors.textMuted }]}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal bounces={false}>
              <ScrollView bounces={false} contentContainerStyle={{ padding: space.md }}>
                {grid}
              </ScrollView>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Row({
  cells,
  header = false,
  theme,
  onOpenLink,
  alignOf,
  widths,
}: {
  cells: TableBlock['header'];
  header?: boolean;
  theme: Theme;
  onOpenLink?: MarkdownProps['onOpenLink'];
  alignOf: (index: number) => 'left' | 'center' | 'right';
  /** The table's shared column grid — one width per column, identical on every row. */
  widths: number[];
}) {
  const { colors, type, space } = theme;
  return (
    <View style={{ flexDirection: 'row', backgroundColor: header ? colors.surface : 'transparent' }}>
      {cells.map((cell, index) => (
        <View
          key={index}
          style={{
            width: widths[index] ?? MIN_COLUMN_WIDTH,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
            alignItems: alignOf(index) === 'center' ? 'center' : alignOf(index) === 'right' ? 'flex-end' : 'flex-start',
          }}
        >
          <Text
            style={[header ? type.subheading : type.bodySmall, { textAlign: alignOf(index) }]}
            selectable
          >
            <Inlines inlines={cell} theme={theme} onOpenLink={onOpenLink} />
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  /** Chrome row shared by the code card and the table card: language/label on the left, action right. */
  codeHeader: { flexDirection: 'row', alignItems: 'center' },
  codeAction: { minHeight: 32, justifyContent: 'center' },
  /** Full-screen table preview: the scrim, and the sheet inside it which owns its own scrolling. */
  fullscreen: { flex: 1, justifyContent: 'center', padding: 12 },
  fullscreenCard: { maxHeight: '80%', overflow: 'hidden' },
});
