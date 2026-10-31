// The name a screen reader gives a text field (webmail components/ui/field.tsx,
// ef13556a0, dcc21acd0, 4e2affe40). Input drew its label as a Text of its
// own, not tied to the field, so TalkBack and VoiceOver announced an
// unnamed "edit box"; a placeholder alone stops being read once the field
// has a value. The label names the field, then the placeholder; an error
// is read as the hint so it is heard on focus.

export interface InputAccessibilityProps {
  label?: string;
  error?: string;
  placeholder?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export function inputAccessibility(props: InputAccessibilityProps): {
  accessibilityLabel?: string;
  accessibilityHint?: string;
} {
  const name = props.accessibilityLabel || props.label || props.placeholder || undefined;
  const hint = props.error || props.accessibilityHint || undefined;
  return {
    ...(name ? { accessibilityLabel: name } : {}),
    ...(hint ? { accessibilityHint: hint } : {}),
  };
}
