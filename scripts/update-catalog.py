import json
import random
from pathlib import Path

CATALOG_FILE = Path('web/catalog.json')

FILLER_CATEGORIES = [
    {
        "name": "Garage Humor",
        "slug": "garage-humor",
        "designs": [
            {
                "id": "garage-humor-001",
                "name": "If You Can Read This Flip Me Back Over",
                "image": "images/catalog/garage-humor-001.jpg",
                "sources": {}
            },
            {
                "id": "garage-humor-002",
                "name": "Built Not Bought",
                "image": "images/catalog/garage-humor-002.jpg",
                "sources": {}
            },
            {
                "id": "garage-humor-003",
                "name": "My Other Ride is in Pieces",
                "image": "images/catalog/garage-humor-003.jpg",
                "sources": {}
            }
        ]
    },
    {
        "name": "Retro Stripes & Shapes",
        "slug": "retro-stripes",
        "designs": [
            {
                "id": "retro-stripes-001",
                "name": "Desert Sunband",
                "image": "images/catalog/retro-stripes-001.jpg",
                "sources": {}
            },
            {
                "id": "retro-stripes-002",
                "name": "Sunset Horizon",
                "image": "images/catalog/retro-stripes-002.jpg",
                "sources": {}
            },
            {
                "id": "retro-stripes-003",
                "name": "Boogie Van Wave",
                "image": "images/catalog/retro-stripes-003.jpg",
                "sources": {}
            }
        ]
    },
    {
        "name": "Camping & Overland",
        "slug": "camping-overland",
        "designs": [
            {
                "id": "camping-overland-001",
                "name": "Take the Scenic Route",
                "image": "images/catalog/camping-overland-001.jpg",
                "sources": {}
            },
            {
                "id": "camping-overland-002",
                "name": "Campfire Nights",
                "image": "images/catalog/camping-overland-002.jpg",
                "sources": {}
            },
            {
                "id": "camping-overland-003",
                "name": "Trail Badge Topo",
                "image": "images/catalog/camping-overland-003.jpg",
                "sources": {}
            }
        ]
    },
    {
        "name": "Anime & Character Slaps",
        "slug": "anime",
        "designs": [
            {
                "id": "anime-001",
                "name": "Chibi Drift Queen",
                "image": "images/catalog/anime-001.jpg",
                "sources": {}
            },
            {
                "id": "anime-002",
                "name": "Night Racer",
                "image": "images/catalog/anime-002.jpg",
                "sources": {}
            },
            {
                "id": "anime-003",
                "name": "Retro Neon Waifu",
                "image": "images/catalog/anime-003.jpg",
                "sources": {}
            }
        ]
    },
    {
        "name": "Skulls & Pin-Up",
        "slug": "skulls-pinup",
        "designs": [
            {
                "id": "skulls-pinup-001",
                "name": "Hot Rod Pin-Up",
                "image": "images/catalog/skulls-pinup-001.jpg",
                "sources": {}
            },
            {
                "id": "skulls-pinup-002",
                "name": "Grim Reaper Flame",
                "image": "images/catalog/skulls-pinup-002.jpg",
                "sources": {}
            },
            {
                "id": "skulls-pinup-003",
                "name": "Rockabilly Queen",
                "image": "images/catalog/skulls-pinup-003.jpg",
                "sources": {}
            }
        ]
    },
    {
        "name": "Club & Crew Logos",
        "slug": "club-logos",
        "designs": [
            {
                "id": "club-logos-001",
                "name": "Midnight Truckers Club",
                "image": "images/catalog/club-logos-001.jpg",
                "sources": {}
            },
            {
                "id": "club-logos-002",
                "name": "Boost Bros Garage",
                "image": "images/catalog/club-logos-002.jpg",
                "sources": {}
            },
            {
                "id": "club-logos-003",
                "name": "Trail Queens Collective",
                "image": "images/catalog/club-logos-003.jpg",
                "sources": {}
            }
        ]
    }
]


def main():
  catalog = json.loads(CATALOG_FILE.read_text())
  categories = catalog.get('categories', [])
  existing_slugs = {cat['slug'] for cat in categories}

  for filler in FILLER_CATEGORIES:
    if filler['slug'] not in existing_slugs:
      categories.append(filler)

  catalog['categories'] = categories
  catalog['generatedAt'] = json.dumps(__import__('datetime').datetime.utcnow(), default=str)
  CATALOG_FILE.write_text(json.dumps(catalog, indent=2))

if __name__ == '__main__':
  main()
