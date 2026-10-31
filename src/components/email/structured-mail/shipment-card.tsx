// Port of webmail components/email/structured-mail/shipment-card.tsx at
// b0782af2d (same rows, React Native views).
import React from 'react';
import { Image, Text, View } from 'react-native';
import { Clock, ExternalLink, Package, ShoppingBag, Truck } from '../../icons';
import { formatMomentDate, formatMoney, isWebLink, shipmentItems, summarizeItems } from '../../../lib/structured-mail/format';
import type { Item, Link, OrderStatus, Parcel, Shipment } from '../../../lib/structured-mail/types';
import { useLocaleStore } from '../../../stores/locale-store';
import { CardLink, CardShell, MetaRow, Pill, useCardFormat, useCardStyles } from './card-parts';
import { CopyValueChip } from './copy-value-chip';

const STATUS_TONE: Record<OrderStatus, 'error' | 'warning' | 'success' | 'info' | 'muted'> = {
  payment_due: 'warning',
  processing: 'muted',
  problem: 'error',
  in_transit: 'info',
  pickup_available: 'success',
  returned: 'muted',
  delivered: 'success',
  cancelled: 'error',
};

/** States in which an expected arrival date is out of date. */
const ARRIVED_OR_STOPPED = new Set<OrderStatus>(['delivered', 'returned', 'cancelled']);

function OrderStatusPill({ status }: { status: OrderStatus }) {
  const t = useLocaleStore((s) => s.t);
  const labels: Record<OrderStatus, string> = {
    payment_due: t('email_viewer.structured_mail.order_status_payment_due', 'Payment due'),
    processing: t('email_viewer.structured_mail.order_status_processing', 'Processing'),
    problem: t('email_viewer.structured_mail.order_status_problem', 'Problem'),
    in_transit: t('email_viewer.structured_mail.order_status_in_transit', 'Shipped'),
    pickup_available: t('email_viewer.structured_mail.order_status_pickup_available', 'Ready for pickup'),
    returned: t('email_viewer.structured_mail.order_status_returned', 'Returned'),
    delivered: t('email_viewer.structured_mail.order_status_delivered', 'Delivered'),
    cancelled: t('email_viewer.structured_mail.order_status_cancelled', 'Cancelled'),
  };
  return <Pill label={labels[status]} tone={STATUS_TONE[status]} />;
}

/** Product images, only when remote content may load for this message; https only. */
function ItemImages({ items }: { items: Item[] }) {
  const { styles } = useCardStyles();
  const shown = items.filter((item) => item.image && isWebLink(item.image) && item.image.url.toLowerCase().startsWith('https:'));
  if (shown.length === 0) return null;
  return (
    <View style={styles.images}>
      {shown.map((item, i) => (
        <Image
          key={`${item.image!.url}-${i}`}
          source={{ uri: item.image!.url }}
          accessibilityIgnoresInvertColors
          style={styles.image}
          testID="structured-mail-item-image"
        />
      ))}
    </View>
  );
}

/** Carrier, tracking number and expected date; no date once the order is delivered, returned or cancelled. */
function ParcelRows({ parcel, showExpected }: { parcel: Parcel; showExpected: boolean }) {
  const t = useLocaleStore((s) => s.t);
  const { c, styles } = useCardStyles();
  const { opts } = useCardFormat();
  const expectedBy = showExpected ? parcel.expectedBy : undefined;
  if (!parcel.carrier && !parcel.trackingNumber && !expectedBy) return null;
  return (
    <>
      {(parcel.carrier || parcel.trackingNumber) ? (
        <View style={[styles.metaRow, { alignItems: 'center' }]} testID="structured-mail-parcel">
          <Truck size={14} color={c.textSecondary} />
          <View style={[styles.pills, { flex: 1 }]}>
            {parcel.carrier ? <Text style={[styles.metaText, styles.strong, { flex: 0 }]}>{parcel.carrier}</Text> : null}
            {!parcel.carrier && parcel.trackingNumber ? (
              <Text style={[styles.metaText, { flex: 0 }]}>{t('email_viewer.structured_mail.tracking_number', 'Tracking number')}</Text>
            ) : null}
            {parcel.trackingNumber ? (
              <CopyValueChip
                value={parcel.trackingNumber}
                copyLabel={t('email_viewer.structured_mail.copy_tracking_number', 'Copy tracking number {value}', { value: parcel.trackingNumber })}
                copiedMessage={t('email_viewer.structured_mail.copied_tracking_number', 'Tracking number copied')}
              />
            ) : null}
          </View>
        </View>
      ) : null}
      {expectedBy ? (
        <MetaRow icon={Clock}>{t('email_viewer.structured_mail.expected_by', 'Arrives by {date}', { date: formatMomentDate(expectedBy, opts) })}</MetaRow>
      ) : null}
    </>
  );
}

interface ShipmentCardProps {
  shipment: Shipment;
  allowRemoteImages: boolean;
}

export function ShipmentCard({ shipment, allowRemoteImages }: ShipmentCardProps) {
  const t = useLocaleStore((s) => s.t);
  const { c, styles } = useCardStyles();
  const { opts } = useCardFormat();
  const carrier = shipment.parcels.find((p) => p.carrier)?.carrier;
  const isParcel = !shipment.orderNumber && !shipment.merchant && shipment.parcels.length > 0;
  const kindLabel = isParcel
    ? t('email_viewer.structured_mail.kind_parcel', 'Parcel')
    : t('email_viewer.structured_mail.kind_order', 'Order');
  const title = shipment.merchant?.trim() || carrier || kindLabel;
  const eyebrow = shipment.merchant && carrier ? `${kindLabel} · ${carrier}` : kindLabel;
  const items = shipmentItems(shipment);
  const { shown, more, count } = summarizeItems(items);
  const total = shipment.total ? formatMoney(shipment.total, opts.locale) : undefined;
  // One Track button per distinct tracking page.
  const trackLinks = shipment.parcels.map((p) => p.trackingUrl)
    .filter((l, i, all): l is Link => isWebLink(l) && all.findIndex((o) => o?.url === l!.url) === i);
  const hasOrderLink = isWebLink(shipment.orderUrl);
  const cancelled = shipment.status === 'cancelled';
  const summary = [
    items.length > 0 ? t('email_viewer.structured_mail.items_count', '{count, plural, one {# item} other {# items}}', { count }) : undefined,
    total ? t('email_viewer.structured_mail.total', 'Total {total}', { total }) : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <CardShell
      kind="shipment"
      name={t('email_viewer.structured_mail.region_shipment', 'Order and delivery')}
      icon={isParcel ? Truck : ShoppingBag}
      cancelled={cancelled}
      eyebrow={eyebrow}
      title={title}
      pills={shipment.status ? <OrderStatusPill status={shipment.status} /> : undefined}
      actions={trackLinks.length > 0 || hasOrderLink ? (
        <>
          {trackLinks.map((link, i) => (
            <CardLink key={`${link.url}-${i}`} link={link} label={t('email_viewer.structured_mail.link_track', 'Track')} icon={Truck} />
          ))}
          <CardLink link={shipment.orderUrl} label={t('email_viewer.structured_mail.link_view_order', 'View order')} icon={ExternalLink} />
        </>
      ) : undefined}
    >
      {shipment.orderNumber ? (
        <View style={[styles.metaRow, { alignItems: 'center' }]} testID="structured-mail-order-number">
          <ShoppingBag size={14} color={c.textSecondary} />
          <View style={[styles.pills, { flex: 1 }]}>
            <Text style={[styles.metaText, { flex: 0 }]}>{t('email_viewer.structured_mail.order_number', 'Order number')}</Text>
            <CopyValueChip
              value={shipment.orderNumber}
              copyLabel={t('email_viewer.structured_mail.copy_order_number', 'Copy order number {value}', { value: shipment.orderNumber })}
              copiedMessage={t('email_viewer.structured_mail.copied_order_number', 'Order number copied')}
            />
          </View>
        </View>
      ) : null}
      {shown.length > 0 ? (
        <View>
          <MetaRow icon={Package}>
            <Text style={styles.strong}>{shown.map((item) => item.name).join(', ')}</Text>
            {more > 0 ? ` ${t('email_viewer.structured_mail.items_more', 'and {count} more', { count: more })}` : null}
          </MetaRow>
          {allowRemoteImages ? <ItemImages items={shown} /> : null}
        </View>
      ) : null}
      {summary ? <Text style={styles.summary} testID="structured-mail-summary">{summary}</Text> : null}
      {shipment.parcels.map((parcel, i) => (
        <ParcelRows key={`${parcel.trackingNumber ?? ''}-${i}`} parcel={parcel} showExpected={!ARRIVED_OR_STOPPED.has(shipment.status ?? 'processing')} />
      ))}
    </CardShell>
  );
}
