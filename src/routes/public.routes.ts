import type { FastifyInstance } from 'fastify';
import * as publicController from '../controllers/public.controller.js';

// Unauthenticated read-only surface for SEO / marketing pages. No preHandler
// hook — every route here is intentionally open to crawlers and unauthed
// visitors. Tighter per-route rate limits guard against scraping.

const publicRoutes = async (fastify: FastifyInstance) => {
    // Marketing-page browsing: 60/min/IP is generous for human reads and
    // still rate-limits aggressive scrapers without hitting genuine search-
    // engine crawlers (Googlebot averages well below 60 req/min).
    const browseLimit = { max: 60, timeWindow: '1 minute' };

    // Sitemap is hit rarely (every few hours by crawlers) but returns up to
    // 50k rows — keep its budget separate so a misconfigured crawler can't
    // pin the DB.
    const sitemapLimit = { max: 10, timeWindow: '1 minute' };

    fastify.get(
        '/public/discover/decks',
        { config: { rateLimit: browseLimit } },
        publicController.discoverDecks,
    );
    fastify.get(
        '/public/discover/categories',
        { config: { rateLimit: browseLimit } },
        publicController.discoverCategories,
    );
    fastify.get(
        '/public/decks/:id',
        { config: { rateLimit: browseLimit } },
        publicController.deckById,
    );
    fastify.get(
        '/public/sitemap/decks',
        { config: { rateLimit: sitemapLimit } },
        publicController.sitemapDecks,
    );
};

export default publicRoutes;
