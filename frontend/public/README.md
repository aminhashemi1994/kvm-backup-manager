# Favicon Icons

This directory contains the favicon icons for the KVM Backup Manager application.

## Files

- **favicon.svg** - Main favicon (100x100 viewBox) with database cylinders and a success checkmark badge
- **favicon-gen.svg** - Smaller 32x32 version optimized for browser tabs

## Design

The favicon features:
- **Blue gradient background** (#3b82f6 to #1e40af) - matches the app theme
- **White database cylinders** - represents backup storage
- **Green checkmark badge** - indicates successful backup
- **Clean, professional design** - easily recognizable in browser tabs

## Usage

The favicons are automatically referenced in `index.html`:
```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="alternate icon" type="image/svg+xml" href="/favicon-gen.svg" />
<link rel="apple-touch-icon" href="/favicon-gen.svg" />
```

## Customization

To modify the icons:
1. Edit the SVG files directly
2. Rebuild the frontend: `npm run build`
3. The icons will be automatically included in the dist folder

The SVG format ensures the icons look crisp at any size and scale.
