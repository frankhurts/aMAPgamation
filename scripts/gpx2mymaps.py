#!/usr/bin/env python3
"""
Convert a GPX file into a KML that Google My Maps imports as one clean layer.

Why not just import the GPX: My Maps synthesizes a "Start of <track>" and
"End of <track>" pin for every track in a GPX, on top of whatever waypoints
the file already has. For a 17-track file that is 34 unwanted pins duplicating
the real stops, and no amount of filtering the GPX removes them because they
are generated at import time. KML placemarks are taken literally, so nothing
is invented.

Why not gpsbabel's KML writer: it labels every LineString "Path" regardless of
labels/trackdata, and nests each track in its own <Folder>. My Maps maps
folders to layers and caps a map at 10, so a 17-track file would not survive.
This writes a flat document instead.

Also undoes the '+' that gmaps2gpx leaves in place names: it decodes the URL
path with unquote() rather than unquote_plus(), so "Missoula,+Montana" keeps
its separators instead of becoming "Missoula, Montana".

    gpx2mymaps.py <input.gpx> <output.kml> [--name "Layer title"]
"""
import argparse
import xml.etree.ElementTree as ET

GPX = "{http://www.topografix.com/GPX/1/1}"
KML_NS = "http://www.opengis.net/kml/2.2"


def clean(name: str) -> str:
    """'+' is a URL-encoded space; a real '+' would have arrived as %2B."""
    return " ".join((name or "").replace("+", " ").split())


def text_of(el, tag):
    if el is None:
        return ""
    found = el.find(GPX + tag)
    return (found.text or "").strip() if found is not None and found.text else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("gpx")
    ap.add_argument("kml")
    ap.add_argument("--name", default="Routes")
    args = ap.parse_args()

    root = ET.parse(args.gpx).getroot()

    ET.register_namespace("", KML_NS)
    kml = ET.Element("{%s}kml" % KML_NS)
    doc = ET.SubElement(kml, "{%s}Document" % KML_NS)
    ET.SubElement(doc, "{%s}name" % KML_NS).text = args.name

    def placemark(name, desc=""):
        pm = ET.SubElement(doc, "{%s}Placemark" % KML_NS)
        if name:
            ET.SubElement(pm, "{%s}name" % KML_NS).text = name
        if desc:
            ET.SubElement(pm, "{%s}description" % KML_NS).text = desc
        return pm

    # Waypoints first so the stop pins draw above the lines in My Maps.
    n_wpt = 0
    for w in root.iter(GPX + "wpt"):
        pm = placemark(clean(text_of(w, "name")), text_of(w, "desc"))
        pt = ET.SubElement(pm, "{%s}Point" % KML_NS)
        ET.SubElement(pt, "{%s}coordinates" % KML_NS).text = (
            f"{float(w.get('lon')):.5f},{float(w.get('lat')):.5f},0"
        )
        n_wpt += 1

    n_trk = 0
    n_vert = 0
    for trk in root.iter(GPX + "trk"):
        coords = [
            f"{float(p.get('lon')):.5f},{float(p.get('lat')):.5f},0"
            for p in trk.iter(GPX + "trkpt")
        ]
        if len(coords) < 2:
            continue
        pm = placemark(clean(text_of(trk, "name")) or f"Route {n_trk + 1}")
        ls = ET.SubElement(pm, "{%s}LineString" % KML_NS)
        ET.SubElement(ls, "{%s}tessellate" % KML_NS).text = "1"
        ET.SubElement(ls, "{%s}coordinates" % KML_NS).text = " ".join(coords)
        n_trk += 1
        n_vert += len(coords)

    ET.ElementTree(kml).write(args.kml, encoding="utf-8", xml_declaration=True)
    print(
        f"  {args.kml}: {n_wpt} marker(s) + {n_trk} route(s) "
        f"({n_vert} vertices), flat — no folders"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
