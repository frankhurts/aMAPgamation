#!/usr/bin/env python3
"""
Build a My Maps-importable KML of the national parks the candidate routes reach.

Reads trips/parks.json (name, state, routes, lat, lng) and writes one flat
Document of Point placemarks sharing a single style.

Icon: Google's own KML shape "parks.png", which is already a green tree on a
light pin, so no <color> tint is needed — tinting an RGBA glyph multiplies its
channels and muddies it. Flat document with no <Folder>, because My Maps maps
folders to layers and caps a map at 10.

    parks-kml.py trips/parks.json trips/parks.kml [--name "Title"]
"""
import argparse
import json
import xml.etree.ElementTree as ET

KML = "http://www.opengis.net/kml/2.2"
ICON = "http://maps.google.com/mapfiles/kml/shapes/parks.png"
ROUTE_NAMES = {"A": "Full Coast", "B": "Parks Priority", "C": "Balanced"}


def sub(parent, tag, text=None):
    e = ET.SubElement(parent, "{%s}%s" % (KML, tag))
    if text is not None:
        e.text = text
    return e


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--name", default="Trip 2 — National Parks")
    args = ap.parse_args()

    parks = json.load(open(args.src))

    ET.register_namespace("", KML)
    kml = ET.Element("{%s}kml" % KML)
    doc = sub(kml, "Document")
    sub(doc, "name", args.name)

    style = ET.SubElement(doc, "{%s}Style" % KML)
    style.set("id", "park")
    icon_style = sub(style, "IconStyle")
    sub(icon_style, "scale", "1.1")
    sub(sub(icon_style, "Icon"), "href", ICON)
    sub(sub(style, "LabelStyle"), "scale", "0.9")

    for p in parks:
        on = ", ".join(ROUTE_NAMES[c] for c in p["routes"])
        pm = sub(doc, "Placemark")
        sub(pm, "name", p["name"])
        # ElementTree escapes &, < and > on write, so plain text is safe here.
        sub(pm, "description",
            f"{p['state']}\nOn {len(p['routes'])} of 3 routes: {on}")
        sub(pm, "styleUrl", "#park")
        point = sub(pm, "Point")
        sub(point, "coordinates", f"{p['lng']:.5f},{p['lat']:.5f},0")

    ET.ElementTree(kml).write(args.out, encoding="utf-8", xml_declaration=True)
    print(f"  {args.out}: {len(parks)} parks, one green tree marker each")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
