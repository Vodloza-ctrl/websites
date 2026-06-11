# websites.co.zw — Content JSON Schema

Each site row has a `content` column (TEXT) containing JSON with two top-level keys:

```json
{
  "theme": { ... },
  "content": { ... }
}
```

---

## `theme` object

```json
{
  "palette":   "ember-cream",
  "font_pair": "playfair-jakarta",
  "sections":  ["hero", "menu", "about", "gallery", "contact"]
}
```

### palette values
| Key | Used for |
|-----|---------|
| `clean-white` | General purpose (default) |
| `black-white-gold` | Luxury / premium |
| `elite-sports` | Sports / dark mode |
| `ember-cream` | Restaurant / grill |
| `blush-plum` | Salon / beauty |
| `navy-gold` | School / church / institution |
| `slate-gold` | Consultant / advisory |
| `forest-cream` | Real estate |

### font_pair values
| Key | Fonts |
|-----|-------|
| `clean-sans` | Space Grotesk + Inter |
| `grotesk-serif` | Fraunces + Plus Jakarta Sans |
| `playfair-jakarta` | Playfair Display + Plus Jakarta Sans |
| `garamond-jost` | Cormorant Garamond + Jost |
| `sports-sans` | Barlow Condensed + Barlow |

### template_id → skin mapping (set on the `sites` row)
| template_id | Skin used |
|-------------|-----------|
| `bold-retail` | Bold retail (default) |
| `grill-house` or `restaurant` | Grill / restaurant |
| `beauty-salon` or `salon` | Beauty salon |
| `school-institution` or `school` or `church` | School / institution |
| `advisory-firm` or `consultant` | Advisory firm |
| `property-estate` or `realestate` | Real estate |
| `sports` | Bold retail + sports-sans |

---

## `content` object — full schema

```json
{
  "business_name": "Gango Grill House",
  "tagline": "Flame-grilled, Borrowdale",
  "location": "Borrowdale, Harare",
  "about": "A two-sentence paragraph about the business. Shown as large pull-quote text.",
  "hours": "Mon–Sat 11am–10pm · Sun 12pm–9pm",

  "contact": {
    "phone": "+263 77 123 4567",
    "email": "hello@gangogrill.co.zw",
    "address": "14 Borrowdale Road, Harare"
  },

  "socials": {
    "whatsapp": "+263771234567",
    "facebook": "https://facebook.com/gangogrill",
    "instagram": "https://instagram.com/gangogrill"
  },

  "images": {
    "hero":    "https://assets.websites.co.zw/site_001/hero.jpg",
    "logo":    "https://assets.websites.co.zw/site_001/logo.png",
    "favicon": "https://assets.websites.co.zw/site_001/favicon.ico",
    "gallery": [
      "https://assets.websites.co.zw/site_001/g1.jpg",
      "https://assets.websites.co.zw/site_001/g2.jpg"
    ],
    "profile": "https://assets.websites.co.zw/site_001/owner.jpg"
  },

  "services": [
    { "title": "Hair braiding", "body": "All styles, lasts 4–6 weeks.", "price": "From $15" },
    { "title": "Nail treatment", "body": "Gel, acrylic, and natural.", "price": "From $8" }
  ],

  "stats": [
    { "value": "340+", "label": "Active players" },
    { "value": "10",   "label": "Years strong" }
  ],

  "team": [
    {
      "name": "Tonderai Moyo",
      "role": "Head Coach · UEFA B Licence",
      "bio": "Former FC Platinum midfielder. 14 years coaching.",
      "photo": "https://assets.websites.co.zw/site_001/coach.jpg"
    }
  ],

  "testimonials": [
    {
      "quote": "The best hardware shop in Mutare. Always stocked.",
      "name": "Chiedza M.",
      "role": "Regular customer",
      "photo": ""
    }
  ],

  "video": {
    "embedUrl": "https://www.youtube.com/embed/abc123",
    "r2Url":    "",
    "poster":   ""
  },

  "menu": {
    "categories": [
      {
        "name": "Starters",
        "items": [
          { "name": "Chicken wings", "description": "Flame-grilled, peri-peri sauce", "price": "$4" },
          { "name": "Soup of the day", "price": "$3" }
        ]
      },
      {
        "name": "Mains",
        "items": [
          { "name": "T-bone steak", "description": "350g, served with chips and salad", "price": "$14" }
        ]
      }
    ]
  },

  "listings": [
    {
      "title": "3-bed townhouse, Borrowdale",
      "type": "For sale",
      "location": "Borrowdale, Harare",
      "price": "$85,000",
      "beds": "3",
      "baths": "2",
      "image": "https://assets.websites.co.zw/site_001/prop1.jpg"
    }
  ]
}
```

---

## Minimal viable content (concierge Phase 1)

The only fields the render Worker absolutely needs to produce a working page:

```json
{
  "theme": { "palette": "ember-cream", "font_pair": "playfair-jakarta" },
  "content": {
    "business_name": "Gango Grill House",
    "tagline": "Flame-grilled · Borrowdale · Harare",
    "images": { "hero": "https://assets.websites.co.zw/site_001/hero.jpg" },
    "socials": { "whatsapp": "263771234567" },
    "contact": { "phone": "+263 77 123 4567", "address": "14 Borrowdale Road, Harare" }
  }
}
```

Everything else (services, gallery, team, menu, stats) renders only when present — all sections are null-safe.

---

## SQL to insert a site (Phase 1 concierge workflow)

```sql
INSERT INTO sites (
  id, owner_id, site_name, status,
  template_id, plan, draft_subdomain,
  content, published_at, expires_at, updated_at
) VALUES (
  'site_002',
  'user_001',
  'Gango Grill House',
  'published',
  'grill-house',
  'starter',
  'gango-grill',
  '{"theme":{"palette":"ember-cream","font_pair":"playfair-jakarta"},"content":{"business_name":"Gango Grill House","tagline":"Flame-grilled · Borrowdale","images":{"hero":"https://assets.websites.co.zw/site_002/hero.jpg"},"socials":{"whatsapp":"263771234567"},"contact":{"phone":"+263 77 123 4567","address":"14 Borrowdale Road, Harare"}}}',
  unixepoch(),
  unixepoch() + 31536000,
  unixepoch()
);
```
