# St. Gregory the Great Orthodox Church — Website Redesign Proposal

## Goals
- **Minimal maintenance** — no WordPress updates, plugin patches, or database backups
- **Maximum reach** — fast, accessible, mobile-first, works on any device
- **SEO optimized** — structured data, semantic HTML, fast Core Web Vitals, proper meta tags

---

## Recommended Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Framework** | Hugo (static site generator) | Fastest build times, zero runtime dependencies, Markdown-based content, huge church/nonprofit theme ecosystem |
| **Hosting** | Netlify (free tier) or GitHub Pages | Free, automatic HTTPS, global CDN, zero server maintenance |
| **CMS** | Decap CMS (formerly Netlify CMS) | Free, Git-based, gives non-technical staff a visual editor without needing a database |
| **Forms** | Netlify Forms or Formspree (free tier) | No backend needed for contact forms |
| **Calendar** | Embedded Google Calendar | Already familiar, zero maintenance, mobile-friendly |
| **Donations** | Tithe.ly or Givelify embed | Purpose-built for churches, handles PCI compliance |
| **Analytics** | Plausible or Google Analytics 4 | Privacy-friendly option or free GA4 |

### Why Not WordPress?
WordPress requires: PHP hosting ($5-20/mo), SSL certificates, regular core/plugin/theme updates, security monitoring, database backups, and performance tuning. A static site eliminates **all** of this. The site loads in under 1 second, is immune to most attacks, and costs $0/month to host.

### Why Not Squarespace/Wix?
- Monthly cost ($16-46/mo)
- Limited SEO control (no custom structured data, limited sitemap control)
- Vendor lock-in
- Slower page loads than static sites

---

## Proposed Site Architecture

```
stgregoryoc.org/
├── / (Home)
├── /about/
│   ├── /about/welcome/          — Visiting & what to expect
│   ├── /about/western-rite/     — The Western Rite in Orthodoxy
│   ├── /about/clergy/           — Fr. Nicholas Alford & Fr. Jeffrey Garcia
│   └── /about/st-gregory/       — Who was St. Gregory the Great?
├── /worship/
│   ├── /worship/schedule/       — Service times & calendar
│   ├── /worship/liturgy/        — The Liturgy of St. Gregory
│   ├── /worship/daily-office/   — Texts & resources for the Daily Office
│   └── /worship/ordo/           — Current year liturgical calendar
├── /learn/
│   ├── /learn/saints/           — Saint biography pages (taxonomy)
│   └── /learn/journal/          — St. Gregory's Journal (blog)
├── /connect/
│   ├── /connect/contact/        — Contact form, email, phone
│   ├── /connect/directions/     — Map, address, parking
│   └── /connect/give/           — Online donations
└── /sitemap.xml (auto-generated)
```

### Key changes from current site:
1. **Consolidated navigation** — 4 top-level items instead of many scattered links
2. **Flattened saint pages** — moved under `/learn/saints/` as a taxonomy collection
3. **Publications integrated** — linked from relevant worship/learn pages, not a standalone page
4. **Contact + Directions merged** under `/connect/`
5. **Giving page added** — many church visitors look for this; currently absent or hard to find

---

## SEO Strategy

### Technical SEO
- **< 1s load time** — static HTML + optimized images (WebP/AVIF with fallbacks)
- **Mobile-first responsive design** — Google's primary ranking factor
- **Semantic HTML5** — `<article>`, `<nav>`, `<header>`, `<main>`, `<section>`
- **Auto-generated sitemap.xml** — Hugo builds this automatically
- **Canonical URLs** — prevent duplicate content issues
- **Open Graph + Twitter Card meta** — rich previews when shared on social

### Structured Data (JSON-LD)
Every page will include schema.org markup:

```json
{
  "@context": "https://schema.org",
  "@type": "Church",
  "name": "St. Gregory the Great Orthodox Church",
  "description": "A Western Rite Orthodox congregation of the Antiochian Archdiocese in Silver Spring, Maryland",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "13407 Roxbury Rd",
    "addressLocality": "Silver Spring",
    "addressRegion": "MD",
    "postalCode": "20904"
  },
  "telephone": "301-288-4798",
  "url": "https://www.stgregoryoc.org",
  "sameAs": [
    "https://www.facebook.com/p/St-Gregory-The-Great-Orthodox-Church-100064364662292/",
    "https://www.youtube.com/@stgregoryorthodox"
  ],
  "openingHoursSpecification": [
    { "dayOfWeek": "Saturday", "opens": "18:00", "description": "Vespers" },
    { "dayOfWeek": "Sunday", "opens": "09:00", "description": "Matins" },
    { "dayOfWeek": "Sunday", "opens": "09:30", "description": "Divine Liturgy" }
  ]
}
```

### Content SEO
- **Target keywords**: "Orthodox Church Silver Spring MD", "Western Rite Orthodox", "Antiochian Orthodox Washington DC", "Orthodox Church near me"
- **Title tag formula**: `Page Name | St. Gregory the Great Orthodox Church`
- **Meta descriptions**: Unique, 150-160 char descriptions for every page
- **Internal linking**: Saint pages link to liturgy pages; liturgy pages link to schedule
- **Blog/Journal**: Regular content signals freshness to Google
- **Alt text on all images**
- **Local SEO**: Google Business Profile (free) synced with site data

### Local SEO Checklist
- [ ] Claim/update Google Business Profile
- [ ] Ensure NAP (Name, Address, Phone) consistency across web
- [ ] Register with Orthodox church directories (Antiochian.org, Orthodox-world.org)
- [ ] Add church to Apple Maps, Bing Places
- [ ] Encourage Google Reviews from parishioners

---

## Design Principles

### Visual Identity
- **Color palette**: Deep navy/midnight blue + gold/amber + cream/off-white — evokes Orthodox liturgical tradition without feeling dated
- **Typography**: Serif heading font (e.g., Cormorant Garamond) for warmth and tradition + clean sans-serif body (e.g., Inter or Source Sans 3) for readability
- **Imagery**: High-quality photos of the church, iconography, community life — compressed to WebP
- **Icons**: Minimal, functional (location pin, clock, phone)

### Layout
- **Hero section**: Full-width image of church interior/exterior with service times overlay
- **Sticky header**: Logo + 4 nav items + "Visit Us" CTA button
- **Footer**: Address, phone, service times, social links, Google Map embed
- **Every page**: Clear call-to-action — visit, contact, give, or learn more

### Accessibility
- WCAG 2.1 AA compliant contrast ratios
- Skip-to-content links
- Keyboard navigable
- Screen reader friendly (proper heading hierarchy, ARIA labels)
- Reduced motion support

---

## Content Migration Plan

### Phase 1 — Core (Week 1-2)
1. Home page with hero, service times, welcome message
2. About/Welcome page
3. Contact + Directions with embedded map
4. Service schedule

### Phase 2 — Worship & Learning (Week 3-4)
5. Liturgy of St. Gregory page
6. Daily Office resources
7. Current year Ordo
8. Western Rite explainer page

### Phase 3 — Content Library (Week 5-6)
9. Saint biography pages (migrated from existing)
10. Journal/blog archive
11. Publications/resources links
12. Clergy bios

### Phase 4 — Enhancements (Week 7-8)
13. Online giving integration
14. Decap CMS setup for staff editing
15. Google Business Profile optimization
16. Analytics setup

---

## Maintenance After Launch

| Task | Frequency | Who | How |
|------|-----------|-----|-----|
| Add journal/blog post | As needed | Staff | Decap CMS visual editor |
| Update service schedule | Seasonally | Staff | Edit one Markdown file or use CMS |
| Update Ordo | Annually | Staff | Upload new PDF or update page |
| Update saint of the day | Never | N/A | Auto-generated from Ordo data |
| Security patches | Never | N/A | Static site = nothing to patch |
| SSL certificate | Never | N/A | Auto-renewed by Netlify |
| Backups | Never | N/A | Site lives in Git — full history preserved |
| Hosting bill | Never | N/A | Free tier covers church traffic easily |

**Total ongoing maintenance: ~1 hour/month** (mostly content updates, not technical work)

---

## Cost Comparison

| Item | Current (WordPress) | Proposed (Hugo + Netlify) |
|------|-------------------|--------------------------|
| Hosting | $5-20/mo | $0 |
| Domain | ~$12/yr | ~$12/yr (keep existing) |
| SSL | $0-10/yr | $0 (auto) |
| CMS | $0 (but maintenance cost) | $0 |
| Contact form | Plugin maintenance | $0 (Netlify Forms) |
| Total annual | $72-252+ | ~$12 |

---

## Next Steps

1. **Approve this proposal** — confirm architecture and design direction
2. **Gather assets** — church photos, logo files, any existing content to migrate
3. **Build starter site** — I can scaffold the Hugo project with the proposed structure
4. **Content population** — migrate text from existing site
5. **Review & launch** — preview on Netlify, then point DNS

---

*Prepared for St. Gregory the Great Orthodox Church — June 2026*
