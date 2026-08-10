#!/usr/bin/env python3
"""Fix HTML issues: pixel noscript bug, missing store.js, and home page sorting."""

import re, os, sys

# Force UTF-8 for stdout
sys.stdout.reconfigure(encoding='utf-8')

# Directory with HTML files
DIR = os.path.dirname(os.path.abspath(__file__))

def fix_pixel_script(content):
    """Fix the pixel script: close </script> before <noscript> instead of inside the script block."""
    return re.sub(
        r"(fbq\('track','PageView'\);\})\n\s*<noscript>",
        r"\1\n  </script>\n  <noscript>",
        content
    )

def add_store_js(content):
    """Add store.js script tag before api.js if not already present."""
    if 'store.js' in content:
        return content
    return content.replace(
        '<script src="./js/api.js"></script>',
        '<script src="./js/store.js"></script>\n<script src="./js/api.js"></script>',
        1
    )

def fix_home_sorting(content):
    """Add sort by createdAt desc on the featured array in index.html."""
    old = (
        '    // Limit to 18 products total (6 categories \xd7 3 each)\n'
        '    grid.innerHTML = featured.slice(0,18).map(function(p) { return renderProductCard(p); }).join(\'\');'
    )
    new = (
        '    // Sort by newest first (createdAt descending) across all categories\n'
        '    featured.sort(function(a, b) {\n'
        '      var aTime = new Date(a.createdAt || 0).getTime();\n'
        '      var bTime = new Date(b.createdAt || 0).getTime();\n'
        '      return bTime - aTime;\n'
        '    });\n'
        '    // Limit to 18 products total\n'
        '    grid.innerHTML = featured.slice(0,18).map(function(p) { return renderProductCard(p); }).join(\'\');'
    )
    content = content.replace(old, new)

    # Also fix the localStorage fallback path (different multiline context)
    old2 = (
        '      grid.innerHTML = featured.slice(0,18).map(function(p) { return renderProductCard(p); }).join(\'\');\n'
        '    } else {'
    )
    new2 = (
        '      featured.sort(function(a, b) {\n'
        '        var aTime = new Date(a.createdAt || 0).getTime();\n'
        '        var bTime = new Date(b.createdAt || 0).getTime();\n'
        '        return bTime - aTime;\n'
        '      });\n'
        '      grid.innerHTML = featured.slice(0,18).map(function(p) { return renderProductCard(p); }).join(\'\');\n'
        '    } else {'
    )
    content = content.replace(old2, new2)
    return content

# Files that need the pixel script fix (all category pages)
pixel_fix_files = ['tops.html', 'Bottoms.html', 'TrackSuits.html', 'Footwear.html', 'accessories.html', 'fragrances.html']

for fname in pixel_fix_files:
    fpath = os.path.join(DIR, fname)
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()
    original = content
    content = fix_pixel_script(content)
    if content != original:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"[OK] Fixed pixel script in {fname}")
    else:
        print(f"[SKIP] No pixel fix needed in {fname}")

# Fragrances also needs store.js
frag_path = os.path.join(DIR, 'fragrances.html')
with open(frag_path, 'r', encoding='utf-8') as f:
    content = f.read()
original = content
content = add_store_js(content)
if content != original:
    with open(frag_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("[OK] Added store.js to fragrances.html")
else:
    print("[SKIP] store.js already present in fragrances.html")

# Index.html needs sorting fix
index_path = os.path.join(DIR, 'index.html')
with open(index_path, 'r', encoding='utf-8') as f:
    content = f.read()
original = content
content = fix_home_sorting(content)
if content != original:
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("[OK] Added createdAt sorting to index.html")
else:
    print("[SKIP] No change needed in index.html")

print("\n[DONE] All fixes applied!")
