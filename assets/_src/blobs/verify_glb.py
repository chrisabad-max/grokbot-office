"""Re-imports every blob GLB in Blender and prints node names, bounds (glTF axes, metres) and triangle counts.
Also reads the raw GLB JSON for materials / extensions.

    blender -b --factory-startup -P verify_glb.py
"""
import bpy, glob, json, os, struct
import numpy as np

OUT = r"C:\Users\Asus\Desktop\bot-hq\assets\blobs"


def glb_json(path):
    with open(path, "rb") as f:
        magic, ver, length = struct.unpack("<4sII", f.read(12))
        clen, ctype = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))


def main():
    bad = []
    for path in sorted(glob.glob(os.path.join(OUT, "*.glb"))):
        name = os.path.basename(path)
        for ob in list(bpy.data.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.ops.import_scene.gltf(filepath=path)
        tris, mins, maxs = 0, np.full(3, 1e9), np.full(3, -1e9)
        nodes = {}
        for ob in bpy.data.objects:
            nodes[ob.name] = ob.parent.name if ob.parent else None
            if ob.type == "MESH":
                me = ob.data
                tris += sum(len(p.vertices) - 2 for p in me.polygons)
                M = ob.matrix_world
                for v in me.vertices:
                    w = M @ v.co
                    g = np.array([w.x, w.z, -w.y])  # Blender (Z up, -Y front) -> glTF (Y up, +Z front)
                    mins = np.minimum(mins, g)
                    maxs = np.maximum(maxs, g)
        j = glb_json(path)
        mats = []
        for m in j.get("materials", []):
            pbr = m.get("pbrMetallicRoughness", {})
            mats.append("%s rough=%.2f coat=%s" % (m["name"], pbr.get("roughnessFactor", 1),
                                                   m.get("extensions", {}).get("KHR_materials_clearcoat", {}).get("clearcoatFactor")))
        size = maxs - mins
        top = [n for n, p in nodes.items() if p is None]
        kids = sorted(n for n, p in nodes.items() if p == "blob")
        ok = (top == ["blob"] and {"body", "eye_L", "eye_R"} <= set(kids) and tris <= 6000
              and abs(mins[1]) < 0.01 and max(size) <= 0.86 and abs((mins[0] + maxs[0]) / 2) < 0.02)
        if not ok:
            bad.append(name)
        print("%-28s %s root=%s children=%s tris=%d" % (name, "OK " if ok else "BAD", top, kids, tris))
        print("    bounds min=(%.3f, %.3f, %.3f) max=(%.3f, %.3f, %.3f) size=(%.3f, %.3f, %.3f)" % (*mins, *maxs, *size))
        print("    materials: " + "; ".join(mats) + "  | file %.0f KB" % (os.path.getsize(path) / 1024))
    print("ALL OK" if not bad else "PROBLEMS: %s" % bad)


main()
