// Dev-only kit gallery (FE-1a). 404 outside `next dev`.
import { notFound } from 'next/navigation';
import { Gallery } from './_kit/Gallery';

export const metadata = { title: 'Primitive kit · Command Center' };

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <Gallery />;
}
