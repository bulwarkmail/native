import type {
  ContactCard,
  ContactAnniversary,
  AnniversaryDate,
  PartialDate,
  Timestamp,
} from '../api/types';
import {
  getContactDisplayName,
  getContactKeywords,
} from './contact-utils';

function escape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function fold(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + (i === 0 ? 75 : 74));
    chunks.push(chunk);
    i += chunk.length;
  }
  return chunks.join('\r\n ');
}

function contextsToTypeParam(contexts?: Record<string, boolean>): string {
  if (!contexts) return '';
  const types = Object.keys(contexts).filter((k) => contexts[k]);
  if (types.length === 0) return '';
  return `;TYPE=${types.join(',')}`;
}

function anniversaryDateToVCardDate(date: AnniversaryDate | undefined): string {
  if (!date) return '';
  if (typeof date === 'string') return date;
  const ts = date as Timestamp;
  if (ts['@type'] === 'Timestamp' && typeof ts.utc === 'string') return ts.utc;
  const pd = date as PartialDate;
  const y = pd.year ? String(pd.year).padStart(4, '0') : '';
  const m = pd.month ? String(pd.month).padStart(2, '0') : '';
  const d = pd.day ? String(pd.day).padStart(2, '0') : '';
  if (!y && !m && !d) return '';
  return `${y || '--'}${m || '--'}${d || '--'}`.replace(/^--/, '--');
}

function findBirthday(contact: ContactCard): ContactAnniversary | undefined {
  if (!contact.anniversaries) return undefined;
  return Object.values(contact.anniversaries).find((a) => a.kind === 'birth');
}

export function contactToVCard(contact: ContactCard): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');

  const displayName = getContactDisplayName(contact) || 'Unnamed';
  lines.push(fold(`FN:${escape(displayName)}`));

  const name = contact.name;
  if (name?.components && name.components.length > 0) {
    const parts: Record<string, string> = {
      surname: '',
      given: '',
      middle: '',
      prefix: '',
      suffix: '',
    };
    for (const c of name.components) {
      if (c.kind in parts) parts[c.kind] = c.value;
    }
    lines.push(fold(
      `N:${escape(parts.surname)};${escape(parts.given)};${escape(parts.middle)};${escape(parts.prefix)};${escape(parts.suffix)}`,
    ));
  } else if (name?.full) {
    lines.push(fold(`N:;${escape(name.full)};;;`));
  }

  if (contact.nicknames) {
    const nick = Object.values(contact.nicknames)
      .map((n) => n.name)
      .filter(Boolean)
      .join(',');
    if (nick) lines.push(fold(`NICKNAME:${escape(nick)}`));
  }

  if (contact.emails) {
    for (const email of Object.values(contact.emails)) {
      if (!email.address) continue;
      lines.push(fold(`EMAIL${contextsToTypeParam(email.contexts)}:${escape(email.address)}`));
    }
  }

  if (contact.phones) {
    for (const phone of Object.values(contact.phones)) {
      if (!phone.number) continue;
      lines.push(fold(`TEL${contextsToTypeParam(phone.contexts)}:${escape(phone.number)}`));
    }
  }

  if (contact.addresses) {
    for (const addr of Object.values(contact.addresses)) {
      const street = addr.components?.find((c) => c.kind === 'name')?.value
        || addr.components?.filter((c) => c.kind === 'number' || c.kind === 'name')
          .map((c) => c.value).join(' ')
        || '';
      const locality = addr.components?.find((c) => c.kind === 'locality')?.value || '';
      const region = addr.components?.find((c) => c.kind === 'region')?.value || '';
      const postcode = addr.components?.find((c) => c.kind === 'postcode')?.value || '';
      const country = addr.components?.find((c) => c.kind === 'country')?.value || addr.countryCode || '';
      lines.push(fold(
        `ADR${contextsToTypeParam(addr.contexts)}:;;${escape(street)};${escape(locality)};${escape(region)};${escape(postcode)};${escape(country)}`,
      ));
    }
  }

  if (contact.organizations) {
    for (const org of Object.values(contact.organizations)) {
      if (!org.name) continue;
      const units = org.units?.map((u) => u.name).filter(Boolean).join(';') || '';
      lines.push(fold(`ORG:${escape(org.name)}${units ? `;${escape(units)}` : ''}`));
    }
  }

  if (contact.titles) {
    for (const title of Object.values(contact.titles)) {
      if (!title.name) continue;
      lines.push(fold(`TITLE:${escape(title.name)}`));
    }
  }

  const birthday = findBirthday(contact);
  if (birthday) {
    const bday = anniversaryDateToVCardDate(birthday.date);
    if (bday) lines.push(fold(`BDAY:${bday}`));
  }

  if (contact.onlineServices) {
    for (const svc of Object.values(contact.onlineServices)) {
      if (!svc.uri) continue;
      lines.push(fold(`URL:${escape(svc.uri)}`));
    }
  }

  if (contact.notes) {
    for (const note of Object.values(contact.notes)) {
      if (!note.note) continue;
      lines.push(fold(`NOTE:${escape(note.note)}`));
    }
  }

  const keywords = getContactKeywords(contact);
  if (keywords.length > 0) {
    lines.push(fold(`CATEGORIES:${keywords.map(escape).join(',')}`));
  }

  if (contact.uid) {
    lines.push(fold(`UID:${escape(contact.uid)}`));
  }

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function contactsToVCard(contacts: ContactCard[]): string {
  return contacts.map(contactToVCard).join('\r\n');
}
