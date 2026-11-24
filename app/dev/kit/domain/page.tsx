// /dev/kit/domain: FE-1b domain-component gallery (dev only). Data comes from the mock DataSource.
import type { Metadata } from 'next';
import { KitGallery } from './_kit/KitGallery';
import { loadKitData } from './_kit/load';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Domain kit · Command Center' };

export default async function DomainKitPage() {
  const data = await loadKitData();
  return <KitGallery data={data} />;
}
