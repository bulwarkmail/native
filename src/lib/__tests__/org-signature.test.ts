import { describe, it, expect } from 'vitest';
import {
  buildOrgSignature,
  effectiveSignatureIdentity,
  fillHtmlTemplate,
  fillTextTemplate,
  finalizeOrgOutgoing,
  orgSignatureSetup,
  placeholdersIn,
  signatureValuesFor,
  textCarriesDisclaimer,
  htmlCarriesDisclaimer,
  type OrgSignatureSetup,
} from '../org-signature';
import { sanitizePolicy, type OrgPolicy } from '../org-policy';

// Ported from the webmail's lib/__tests__/org-signature.test.ts and
// lib/org/__tests__/outgoing.test.ts.

const FULL = signatureValuesFor(
  { name: 'Alex Example', email: 'alex@Example.org' },
  { title: 'CEO', department: 'Sales', phone: '+49 30 1', mobile: '+49 170 2' },
  'ACME Ltd',
);
const NO_DETAILS = signatureValuesFor({ name: 'Alex Example', email: 'alex@example.org' }, null, 'ACME Ltd');

describe('placeholder values', () => {
  it('derives identity, domain and company from the identity and the config', () => {
    expect(FULL).toMatchObject({
      name: 'Alex Example',
      email: 'alex@Example.org',
      identity: 'Alex Example <alex@Example.org>',
      domain: 'example.org',
      company: 'ACME Ltd',
      title: 'CEO',
    });
    expect(signatureValuesFor({ name: '', email: 'x@y.test' }, null, '').identity).toBe('x@y.test');
    expect(placeholdersIn('{name} {phone} {unknown} {phone}')).toEqual(['name', 'phone']);
  });
});

describe('fillTextTemplate', () => {
  it('fills in every placeholder and leaves unknown braces alone', () => {
    expect(fillTextTemplate('{name}, {title}\n{company} ({domain}) {other}', FULL))
      .toBe('Alex Example, CEO\nACME Ltd (example.org) {other}');
  });

  it('drops a line whose placeholders are all empty, and keeps one with some value', () => {
    const template = '{name}\n{title}, {department}\nPhone: {phone}\nMobile: {mobile}\nACME Ltd';
    expect(fillTextTemplate(template, NO_DETAILS)).toBe('Alex Example\nACME Ltd');
    expect(fillTextTemplate(template, { ...NO_DETAILS, department: 'Sales' })).toBe('Alex Example\n, Sales\nACME Ltd');
  });

  it('does not escape in plain text', () => {
    expect(fillTextTemplate('{name}', { name: 'A & <B>' })).toBe('A & <B>');
  });
});

describe('fillHtmlTemplate', () => {
  it('HTML-escapes the values, in text and in attributes', () => {
    const html = fillHtmlTemplate('<p>{name}</p><a href="tel:{phone}">call</a>', {
      name: '<img src=x onerror=alert(1)> & co',
      phone: '1" onclick="x',
    });
    expect(html).toContain('<p>&lt;img src=x onerror=alert(1)&gt; &amp; co</p>');
    expect(html).toContain('href="tel:1&quot; onclick=&quot;x"');
    expect(html).not.toContain('<img');
  });

  it('drops lines between <br>s whose placeholders are all empty, with their line break', () => {
    const template = '<p><b>{name}</b><br>{title}<br>Phone: {phone}<br>Mobile: {mobile}</p><p>ACME Ltd</p>';
    expect(fillHtmlTemplate(template, FULL))
      .toBe('<p><b>Alex Example</b><br>CEO<br>Phone: +49 30 1<br>Mobile: +49 170 2</p><p>ACME Ltd</p>');
    expect(fillHtmlTemplate(template, NO_DETAILS)).toBe('<p><b>Alex Example</b></p><p>ACME Ltd</p>');
    expect(fillHtmlTemplate(template, { ...NO_DETAILS, mobile: '9' }))
      .toBe('<p><b>Alex Example</b><br>Mobile: 9</p><p>ACME Ltd</p>');
  });

  it('drops a paragraph and a table row whose placeholders are all empty', () => {
    const template = '<p>{name}</p><p>Phone: {phone}</p><table><tbody><tr><td>Mobile</td><td>{mobile}</td></tr>'
      + '<tr><td>Web</td><td>example.org</td></tr></tbody></table>';
    expect(fillHtmlTemplate(template, NO_DETAILS))
      .toBe('<p>Alex Example</p><table><tbody><tr><td>Web</td><td>example.org</td></tr></tbody></table>');
  });

  it('drops a line whose only placeholder is in a link', () => {
    expect(fillHtmlTemplate('{name}<br><a href="tel:{phone}">Call me</a>', NO_DETAILS)).toBe('Alex Example');
  });

  it('keeps lines and blocks without placeholders, empty ones included', () => {
    expect(fillHtmlTemplate('<p>{mobile}</p><p><br></p><hr><p>Static</p>', NO_DETAILS))
      .toBe('<p><br></p><hr><p>Static</p>');
  });

  it('finds lines inside inline wrappers, the way Outlook and Gmail write signatures', () => {
    const outlook = '<div><span style="font-family:Arial"><b>{name}</b><br>Phone: {phone}<br>Mobile: {mobile}</span></div>';
    expect(fillHtmlTemplate(outlook, { ...NO_DETAILS, phone: '1' }))
      .toBe('<div><span style="font-family:Arial"><b>Alex Example</b><br>Phone: 1</span></div>');
    const gmail = '<div dir="ltr"><font face="arial"><span>{name}<br></span><span>T: {phone}<br></span><span>ACME</span></font></div>';
    expect(fillHtmlTemplate(gmail, NO_DETAILS))
      .toBe('<div dir="ltr"><font face="arial"><span>Alex Example<br></span><span>ACME</span></font></div>');
    expect(fillHtmlTemplate('<p>{name}<br><b>Mobile:</b> <i>{mobile}</i><br>ACME</p>', NO_DETAILS)).toBe('<p>Alex Example<br>ACME</p>');
  });

  it('keeps a logo on a line whose placeholders are empty, and an image that took a placeholder goes', () => {
    expect(fillHtmlTemplate('<div><img src="https://acme.test/logo.png" alt="ACME"> {phone}</div><div>{name}</div>', NO_DETAILS))
      .toBe('<div><img src="https://acme.test/logo.png" alt="ACME"></div><div>Alex Example</div>');
    expect(fillHtmlTemplate('<p>{name}<br><img src="https://acme.test/{title}.png"></p>', NO_DETAILS)).toBe('<p>Alex Example</p>');
  });
});

describe('buildOrgSignature', () => {
  it('is null without a template, and fills both templates otherwise', () => {
    expect(buildOrgSignature({ html: ' ', text: '' }, FULL)).toBeNull();
    expect(buildOrgSignature({ html: '<p>{name}</p>', text: '' }, FULL)).toEqual({ html: '<p>Alex Example</p>', text: '' });
    expect(buildOrgSignature({ html: '', text: '{name}' }, FULL)).toEqual({ html: '', text: 'Alex Example' });
  });
});

describe('effectiveSignatureIdentity', () => {
  const ME = { id: 'me', name: 'Me', email: 'me@example.org', htmlSignature: '<b>Mine</b>', textSignature: 'Mine' };
  const TEAM = { id: 'team', name: 'Team', email: 'team@example.org', htmlSignature: '', textSignature: '' };
  const ORG = { html: '<p>Org</p>', text: 'Org' };
  const NONE = { locked: false, hidden: false };

  it('changes nothing without an organisation signature', () => {
    expect(effectiveSignatureIdentity(ME, ME, null, { locked: true, hidden: false })).toBe(ME);
  });

  it('is the default for an identity without its own signature', () => {
    expect(effectiveSignatureIdentity(ME, ME, ORG, NONE)).toBe(ME);
    expect(effectiveSignatureIdentity(null, TEAM, ORG, NONE)).toEqual({ ...TEAM, htmlSignature: '<p>Org</p>', textSignature: 'Org' });
  });

  it('replaces every signature when locked or hidden, as the sending identity', () => {
    expect(effectiveSignatureIdentity(ME, TEAM, ORG, { locked: true, hidden: false }))
      .toEqual({ ...TEAM, htmlSignature: '<p>Org</p>', textSignature: 'Org' });
    expect(effectiveSignatureIdentity(ME, ME, ORG, { locked: false, hidden: true })?.htmlSignature).toBe('<p>Org</p>');
  });
});

function policyWith(raw: Record<string, unknown>): OrgPolicy {
  const policy = sanitizePolicy({ features: {}, restrictions: {}, defaults: {}, ...raw });
  if (!policy) throw new Error('policy did not sanitize');
  return policy;
}

const ALICE = { name: 'Alice', email: 'alice@example.org' };
const DETAILS = { title: '', department: '', phone: '+49 1', mobile: '' };

describe('orgSignatureSetup', () => {
  it('reads the templates and the signature restriction from the policy', () => {
    const policy = policyWith({
      restrictions: { signature: { locked: true } },
      organisation: { signature: { html: '<p>{name}</p>', text: '{name}' }, disclaimer: { html: '', text: 'Confidential {domain}' } },
    });
    expect(orgSignatureSetup(policy, ALICE, null, '')).toEqual({
      signature: { html: '<p>Alice</p>', text: 'Alice' },
      disclaimer: { html: '', text: 'Confidential example.org' },
      restriction: { locked: true, hidden: false },
    });
  });

  it('has nothing without a policy or without templates', () => {
    expect(orgSignatureSetup(null, ALICE, null, '')).toEqual({ signature: null, disclaimer: null, restriction: { locked: false, hidden: false } });
    expect(orgSignatureSetup(policyWith({ organisation: { signature: 'nope' } }), ALICE, null, '').signature).toBeNull();
  });
});

const SEPARATOR = { separator: true };

function lockedSetup(): OrgSignatureSetup {
  const policy = policyWith({
    restrictions: { signature: { locked: true } },
    organisation: { signature: { html: '<p><b>{name}</b><br>Phone: {phone}</p>', text: '{name}\nPhone: {phone}' } },
  });
  return orgSignatureSetup(policy, ALICE, DETAILS, '');
}

describe('locked organisation signature on send', () => {
  it('puts it back once when the user deleted it from an HTML mail', () => {
    const out = finalizeOrgOutgoing({ html: '<div><p>Hi</p></div>', text: 'Hi' }, lockedSetup(), SEPARATOR);
    expect(out.html).toBe('<div><p>Hi</p></div><br><br>-- <br><p><b>Alice</b><br>Phone: +49 1</p>');
    expect(out.text).toBe('Hi\n\n-- \nAlice\nPhone: +49 1');
    expect(finalizeOrgOutgoing(out, lockedSetup(), SEPARATOR)).toEqual(out);
  });

  it('puts it back in a plain-text mail', () => {
    expect(finalizeOrgOutgoing({ text: 'Hi' }, lockedSetup(), SEPARATOR)).toEqual({ html: undefined, text: 'Hi\n\n-- \nAlice\nPhone: +49 1' });
  });

  it('leaves a mail that carries it alone', () => {
    const html = '<div><p>Hi</p><p data-signature-block="separator">-- </p><div data-signature-block="body"><p><b>Alice</b><br>Phone: +49 1</p></div><p data-signature-block="end"><br></p></div>';
    const bodies = { html, text: 'Hi\n\n-- \nAlice\nPhone: +49 1' };
    expect(finalizeOrgOutgoing(bodies, lockedSetup(), SEPARATOR)).toEqual(bodies);
    const text = { text: 'Hi\n\n-- \nAlice\nPhone: +49 1\n\nOn Monday Bob wrote:\n> question' };
    expect(finalizeOrgOutgoing(text, lockedSetup(), SEPARATOR)).toEqual(text);
  });

  it('does not count the copy in the quoted message', () => {
    const html = '<div><p>Hi</p><blockquote><p><b>Alice</b><br>Phone: +49 1</p></blockquote></div>';
    const out = finalizeOrgOutgoing({ html, text: 'Hi\n\n> Alice\n> Phone: +49 1' }, lockedSetup(), SEPARATOR);
    expect(out.html!.split('Phone: +49 1').length - 1).toBe(2);
    expect(out.text.endsWith('-- \nAlice\nPhone: +49 1')).toBe(true);
  });

  it('does nothing when the signature is not locked', () => {
    const setup = { ...lockedSetup(), restriction: { locked: false, hidden: false } };
    const bodies = { html: '<div><p>Hi</p></div>', text: 'Hi' };
    expect(finalizeOrgOutgoing(bodies, setup, SEPARATOR)).toEqual(bodies);
  });
});

function disclaimerSetup(disclaimer: { html: string; text: string }): OrgSignatureSetup {
  return orgSignatureSetup(policyWith({ organisation: { disclaimer } }), ALICE, null, '');
}

describe('organisation disclaimer on send', () => {
  it('goes below everything: a line and the HTML, a blank line and the text', () => {
    const setup = disclaimerSetup({ html: '<p>Confidential <b>{domain}</b></p>', text: 'Confidential {domain}' });
    const out = finalizeOrgOutgoing({ html: '<div><p>Hi</p><blockquote>quote</blockquote></div>', text: 'Hi\n\n> quote\n' }, setup, SEPARATOR);
    expect(out.html).toBe('<div><p>Hi</p><blockquote>quote</blockquote></div><hr><div data-org-disclaimer=""><p>Confidential <b>example.org</b></p></div>');
    expect(out.text).toBe('Hi\n\n> quote\n\nConfidential example.org');
  });

  it('makes the text from the HTML when there is none, and only text for a plain-text mail', () => {
    // The app's htmlToPlainText keeps a blank line between paragraphs.
    const setup = disclaimerSetup({ html: '<p>Line one</p><p>Line two</p>', text: '' });
    expect(finalizeOrgOutgoing({ html: '<div>Hi</div>', text: 'Hi' }, setup, SEPARATOR).text).toBe('Hi\n\nLine one\n\nLine two');
    expect(finalizeOrgOutgoing({ text: 'Hi' }, setup, SEPARATOR)).toEqual({ html: undefined, text: 'Hi\n\nLine one\n\nLine two' });
  });

  it('is added once: not again to a body that ends with it, but also to a reply quoting it', () => {
    const setup = disclaimerSetup({ html: '', text: 'Confidential.' });
    const once = finalizeOrgOutgoing({ html: '<div>Hi</div>', text: 'Hi' }, setup, SEPARATOR);
    expect(once.html).toBe('<div>Hi</div><hr><div data-org-disclaimer="">Confidential.</div>');
    expect(finalizeOrgOutgoing(once, setup, SEPARATOR)).toEqual(once);
    expect(htmlCarriesDisclaimer(once.html!, setup.disclaimer!)).toBe(true);
    const reply = finalizeOrgOutgoing({ text: 'Thanks\n\n> Hi\n>\n> Confidential.' }, setup, SEPARATOR);
    expect(reply.text).toBe('Thanks\n\n> Hi\n>\n> Confidential.\n\nConfidential.');
    expect(textCarriesDisclaimer(reply.text, setup.disclaimer!)).toBe(true);
    const htmlReply = finalizeOrgOutgoing(
      { html: '<div><p>Thanks</p><blockquote><p>Hi</p><p>Confidential.</p></blockquote></div>', text: 'Thanks\n\nHi\n\nConfidential.' },
      setup, SEPARATOR,
    );
    expect(htmlReply.html!.split('Confidential.').length - 1).toBe(2);
    expect(htmlReply.text).toBe('Thanks\n\nHi\n\nConfidential.\n\nConfidential.');
  });

  it('comes after a locked signature that was put back', () => {
    const policy = policyWith({
      restrictions: { signature: { locked: true } },
      organisation: { signature: { html: '', text: 'Sig {name}' }, disclaimer: { html: '', text: 'Disclaimer' } },
    });
    const out = finalizeOrgOutgoing({ text: 'Hi' }, orgSignatureSetup(policy, ALICE, null, ''), SEPARATOR);
    expect(out.text).toBe('Hi\n\n-- \nSig Alice\n\nDisclaimer');
  });
});
