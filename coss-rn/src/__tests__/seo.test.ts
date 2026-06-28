declare const require: (id: string) => any;
declare const __dirname: string;

const fs = require('node:fs');
const path = require('node:path');

import {
  cossPolicyRoutes,
  cossSiteRoutes,
  cossSourceSitemapRoutes,
} from '../cossContent';

const appRoot = path.resolve(__dirname, '../..');

describe('COSS Korea SEO migration artifacts', () => {
  it('ships canonical cosskorea.com metadata without indexing the console host', () => {
    const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');

    expect(html).toContain('COSS Korea | Innovation Partner Outsourcing');
    expect(html).toContain('rel="canonical" href="https://www.cosskorea.com/"');
    expect(html).toContain('property="og:url" content="https://www.cosskorea.com/"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('console.cosskorea.com');
    expect(html).not.toContain('rel="canonical" href="https://cossok.com/"');
  });

  it('publishes robots and a public sitemap for every copied source route', () => {
    const robots = fs.readFileSync(path.join(appRoot, 'public/robots.txt'), 'utf8');
    const sitemap = fs.readFileSync(path.join(appRoot, 'public/sitemap.xml'), 'utf8');

    expect(robots).toContain('Sitemap: https://www.cosskorea.com/sitemap.xml');
    for (const route of [...cossSourceSitemapRoutes, ...cossPolicyRoutes]) {
      expect(sitemap).toContain(
        route === '/'
          ? 'https://www.cosskorea.com/'
          : `https://www.cosskorea.com${route.replace('#', '%23')}`,
      );
    }
    for (const route of cossSiteRoutes) {
      expect(sitemap).toContain(
        route === '/'
          ? 'https://www.cosskorea.com/'
          : `https://www.cosskorea.com${route.replace('#', '%23')}`,
      );
    }
    expect(sitemap).not.toContain('console.cosskorea.com');
  });
});
