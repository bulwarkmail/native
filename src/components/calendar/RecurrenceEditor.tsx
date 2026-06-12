import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { ChevronDown } from 'lucide-react-native';
import { format, parseISO } from 'date-fns';
import type { RecurrenceRule } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button } from '..';
import {
  EDITOR_FREQUENCIES,
  UNIT_LABELS,
  WEEKDAYS,
  buildRecurrenceSummary,
  buildRuleFromEditorValue,
  capitalize,
  editorValueFromRule,
  monthName,
  nthLabel,
  weekdayName,
  type EditorFrequency,
  type EndsMode,
  type MonthlyMode,
  type RecurrenceEditorValue,
} from '../../lib/recurrence';

interface RecurrenceEditorProps {
  rule: RecurrenceRule | null;
  eventStart: Date;
  onSave: (rule: RecurrenceRule) => void;
  onCancel: () => void;
}

// Small popover-style select, matching the EventModal field pattern.
function InlineSelect<T extends string | number>({
  value,
  options,
  onChange,
  flex,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  flex?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <View style={flex ? styles.selectFlex : undefined}>
      <Pressable style={styles.selectButton} onPress={() => setOpen((v) => !v)}>
        <Text style={styles.selectText} numberOfLines={1}>
          {selected?.label ?? String(value)}
        </Text>
        <ChevronDown size={14} color={c.textMuted} />
      </Pressable>
      {open && (
        <View style={styles.popover}>
          {options.map((opt) => (
            <Pressable
              key={String(opt.value)}
              style={[styles.popoverRow, opt.value === value && styles.popoverRowActive]}
              onPress={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              <Text style={styles.popoverRowText}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onEndEditing={() => {
        const n = parseInt(text, 10);
        const clamped = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
        setText(String(clamped));
        onChange(clamped);
      }}
      keyboardType="number-pad"
      style={styles.numberInput}
    />
  );
}

export function RecurrenceEditor({ rule, eventStart, onSave, onCancel }: RecurrenceEditorProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);

  const [value, setValue] = React.useState<RecurrenceEditorValue>(() =>
    editorValueFromRule(rule, eventStart),
  );
  const [showUntilPicker, setShowUntilPicker] = React.useState(false);

  const update = (patch: Partial<RecurrenceEditorValue>) =>
    setValue((prev) => ({ ...prev, ...patch }));

  const toggleWeekDay = (day: string) => {
    setValue((prev) => ({
      ...prev,
      weekDays: prev.weekDays.includes(day)
        ? prev.weekDays.length > 1
          ? prev.weekDays.filter((d) => d !== day)
          : prev.weekDays
        : [...prev.weekDays, day],
    }));
  };

  const builtRule = buildRuleFromEditorValue(value, eventStart);
  const summary = buildRecurrenceSummary(builtRule);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Every</Text>
        <NumberInput
          value={value.interval}
          min={1}
          max={999}
          onChange={(interval) => update({ interval })}
        />
        <InlineSelect<EditorFrequency>
          flex
          value={value.frequency}
          options={EDITOR_FREQUENCIES.map((f) => ({ value: f, label: UNIT_LABELS[f] }))}
          onChange={(frequency) => update({ frequency })}
        />
      </View>

      {value.frequency === 'weekly' && (
        <View style={styles.weekdayRow}>
          {WEEKDAYS.map((day) => {
            const active = value.weekDays.includes(day);
            return (
              <Pressable
                key={day}
                onPress={() => toggleWeekDay(day)}
                style={[styles.weekdayChip, active && styles.weekdayChipActive]}
              >
                <Text style={[styles.weekdayChipText, active && styles.weekdayChipTextActive]}>
                  {weekdayName(day, 'short')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {value.frequency === 'yearly' && (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>In</Text>
          <InlineSelect<number>
            flex
            value={value.month}
            options={Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ({
              value: m,
              label: capitalize(monthName(m)),
            }))}
            onChange={(month) => update({ month })}
          />
        </View>
      )}

      {(value.frequency === 'monthly' || value.frequency === 'yearly') && (
        <View style={styles.row}>
          <InlineSelect<MonthlyMode>
            value={value.monthlyMode}
            options={[
              { value: 'day', label: 'On day' },
              { value: 'nth', label: 'On the' },
            ]}
            onChange={(monthlyMode) => update({ monthlyMode })}
          />
          {value.monthlyMode === 'day' ? (
            <NumberInput
              value={value.monthDay}
              min={1}
              max={31}
              onChange={(monthDay) => update({ monthDay })}
            />
          ) : (
            <>
              <InlineSelect<number>
                flex
                value={value.nth}
                options={[1, 2, 3, 4, -1].map((n) => ({ value: n, label: capitalize(nthLabel(n)) }))}
                onChange={(nth) => update({ nth })}
              />
              <InlineSelect<string>
                flex
                value={value.nthDay}
                options={WEEKDAYS.map((d) => ({ value: d, label: capitalize(weekdayName(d)) }))}
                onChange={(nthDay) => update({ nthDay })}
              />
            </>
          )}
        </View>
      )}

      <View style={styles.row}>
        <Text style={styles.rowLabel}>Ends</Text>
        <InlineSelect<EndsMode>
          flex={value.endsMode === 'never'}
          value={value.endsMode}
          options={[
            { value: 'never', label: 'Never' },
            { value: 'on', label: 'On date' },
            { value: 'after', label: 'After' },
          ]}
          onChange={(endsMode) => update({ endsMode })}
        />
        {value.endsMode === 'on' && (
          <Pressable style={[styles.selectButton, styles.selectFlex]} onPress={() => setShowUntilPicker(true)}>
            <Text style={styles.selectText}>
              {format(parseISO(value.untilDate), 'MMM d, yyyy')}
            </Text>
          </Pressable>
        )}
        {value.endsMode === 'after' && (
          <>
            <NumberInput
              value={value.count}
              min={1}
              max={999}
              onChange={(count) => update({ count })}
            />
            <Text style={styles.muted}>occurrences</Text>
          </>
        )}
      </View>

      <View style={styles.footer}>
        <Text style={styles.summary} numberOfLines={2}>
          {summary}
        </Text>
        <View style={styles.footerButtons}>
          <Button variant="outline" size="sm" onPress={onCancel}>
            Cancel
          </Button>
          <Button variant="default" size="sm" onPress={() => onSave(builtRule)}>
            Done
          </Button>
        </View>
      </View>

      {showUntilPicker && (
        <DateTimePicker
          value={parseISO(value.untilDate)}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(_, d) => {
            setShowUntilPicker(false);
            if (d) update({ untilDate: format(d, 'yyyy-MM-dd') });
          }}
        />
      )}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.surface,
      padding: spacing.md,
      gap: spacing.sm,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    rowLabel: { ...typography.body, color: c.textSecondary },
    muted: { ...typography.caption, color: c.textMuted, flexShrink: 1 },

    numberInput: {
      minWidth: 52,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.xs,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
      color: c.text,
      ...typography.body,
      textAlign: 'center',
    },

    selectFlex: { flex: 1, minWidth: 0 },
    selectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      minHeight: 36,
      borderRadius: radius.xs,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    selectText: { ...typography.body, color: c.text, flexShrink: 1 },

    popover: {
      marginTop: spacing.xs,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.xs,
      backgroundColor: c.background,
      overflow: 'hidden',
    },
    popoverRow: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    popoverRowActive: { backgroundColor: c.primaryBg },
    popoverRowText: { ...typography.body, color: c.text },

    weekdayRow: { flexDirection: 'row', gap: 4 },
    weekdayChip: {
      flex: 1,
      minWidth: 0,
      paddingVertical: spacing.xs,
      borderRadius: radius.xs,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
    },
    weekdayChipActive: {
      borderColor: c.primary,
      backgroundColor: c.primaryBg,
    },
    weekdayChipText: { ...typography.caption, color: c.textMuted },
    weekdayChipTextActive: { color: c.primary },

    footer: {
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: spacing.sm,
      gap: spacing.sm,
    },
    summary: { ...typography.caption, color: c.textMuted },
    footerButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  });
}
