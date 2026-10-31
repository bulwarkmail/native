// extract.ts on the app's parser (html-parser.ts), which stands in for the
// webmail's DOMParser: what the ported extract tests don't cover.
import { describe, expect, it } from 'vitest';
import { extractStructuredData } from '../extract';

describe('extractStructuredData on the app parser', () => {
  it('reads microdata with entities and nested items from the default parser', () => {
    const html = `<div itemscope itemtype="http://schema.org/ParcelDelivery">
      <span itemprop="carrier">Deutsche Post &amp; DHL</span>
      <div itemprop="partOfOrder" itemscope itemtype="http://schema.org/Order"><meta itemprop="orderNumber" content="A&#45;1"></div>
    </div>`;
    expect(extractStructuredData(html)).toEqual([{
      source: 'microdata',
      item: {
        '@context': 'https://schema.org', '@type': 'ParcelDelivery', carrier: 'Deutsche Post & DHL',
        partOfOrder: { '@type': 'Order', orderNumber: 'A-1' },
      },
    }]);
  });

  it('skips JSON-LD after the Outlook forward separator', () => {
    const ld = '<script type="application/ld+json">{"@context":"http://schema.org","@type":"Order","orderNumber":"1"}</script>';
    expect(extractStructuredData(`<div>${ld}</div>`)).toHaveLength(1);
    expect(extractStructuredData(`<p>FYI</p><div id="divRplyFwdMsg">From: x</div><div>${ld}</div>`)).toEqual([]);
  });
});
