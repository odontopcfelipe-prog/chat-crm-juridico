import { MetadataRoute } from 'next';

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || '';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/atendimento/', '/portal/'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
