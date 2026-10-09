# jungles dataset: notes

`jungles.json` contains **198 samples**: Amazon 65, Congo 62, Southeast Asia 71. Each sample is a center plus a zoom (11-16) on
rainforest-dominated, cloud-free Google satellite imagery. Everything was eyeballed by a human-in-the-loop pass:
every kept sample, and every Haiku reject that looked plausible. The total target of ~220 / 70-80 per class was
not fully reached, because the 400-request Static Maps allowance ran out (see "Gaps").

Files:
- `jungle_regions.geojson`: 17 hand-drawn sampling polygons (3 classes x subregions), clipped to Natural Earth land.
  Known non-forest blocks are cut out: Roraima/Rupununi and Gran Sabana savannas, the Batéké plateau, Trans-Fly, and Port Moresby.
- `jungle_candidates.json`: all 400 random candidates, in batches 1 = pilot, 2 = scale-up, 3 = targeted top-up.
- `jungle_scores.json`: Haiku v3 scores for all candidates. `jungle_scores_v1/v2.json` are earlier prompt
  iterations on the pilot. `jungle_scores_sonnet_sample.json` is the Sonnet cross-check.
- Scripts are in `tools/jungles/`: `regions.py`, `sample.py`, `fetch.py`, `classify.py` (prompt + schema + keep rule), `pix.py`
  (pixel checks), `sheets.py`, `compare.py`, `build.py` (scores + pixel checks + `overrides.json` -> `jungles.json`), and
  `evaluate.py`. `overrides.json` holds every manual QA decision, with a reason.

## Sampling

Points are uniform over polygon land area, so subregions get candidates in proportion to area. After filtering,
the kept share tracks the share of *intact* forest, because deforested points get rejected. Zooms come round-robin from
{11..16}. Minimum spacing is max(15 km, 0.6 x frame width at the lower zoom), so z11 frames (~49 km) do not overlap
much. The closest kept pair is 18 km apart.

## What makes a good sample (criteria)

Keep a sample only if all of these hold:
1. **Rainforest-dominated**: at least ~50% natural closed forest. Swamp forest and regrowth count. Oil palm, acacia, rubber, pasture, crops, savanna, water and towns do not.
   Human cues (fishbone, plantation grid, clearings) are welcome as a *minority* of the frame. Frames that are mostly
   plantation or pasture were rejected, even very iconic ones such as a fully cleared Rondônia fishbone or a pure acacia grid.
2. **Cloud-free**: even a few small cumulus puffs were rejected (17 cases). Haiku under-reports small clouds, and dim
   tropical clouds are not pure white, so the pixel check only catches the obvious ones.
3. **Not featureless**: this is the biggest failure mode. At z11-13 (and some z14-15), Google often serves a soft
   Landsat-grade mosaic that is a flat olive-green field with nothing to learn. These are worst in the Congo: z13 kept only 3 of
   24 candidates. They are rejected by eye, and in the pipeline by a pixel rule (high-pass detail < 2.0 and gray std < 5.5).
   Crisp z15-16 *pure canopy* is the opposite case. It is the best hard-mode material, and Haiku under-scores it as "plain",
   so 14 of those were recovered manually.
4. **No dominating imagery artifacts**: reject strong rectangular mosaic patchwork, heavy haze or blur from upscaled tiles,
   odd color casts (purple, grey), and blank "no imagery" tiles (about 1 in 6 at z16 in the pilot, detected by pixel std).
   Mild seams are kept, because the live game shows them too.

Quality: 3 = acceptable but plain. 4 = clean with clear texture or a cue. 5 = striking. 12 samples are rated 5:
amazon-008/018/020/049, congo-087/120/129/130, seasia-001/022/036/072.

## Tags and difficulty

The tags come from Haiku and were then hand-corrected. Haiku systematically called any meandering river "oxbow", called Congo
savanna patches "pasture", and called SE Asian ridge-top logging roads "fishbone". 40+ tag fixes are recorded in
`overrides.json`.

Difficulty is computed in `build.py` and is region-aware: *easy* means the frame contains a cue that gives away *that* region.
- Amazon: fishbone-deforestation, pasture, oxbow, blackwater
- Congo: savanna-edge (forest-savanna mosaic), settlement + road/logging-roads (beaded village roads)
- SE Asia: plantation, mountains, coast, logging-roads + hills, fishbone
- *hard*: the tags contain only pristine-canopy / hills / swamp-forest / mosaic-seams / cloud-shadow
- *medium*: everything else (rivers, clearings, roads without a diagnostic pattern)

## Haiku prompt (v3, `tools/jungles/classify.py`)

The schema fields are no_imagery, cloud_pct, haze, forest_pct, water_pct, texture (featureless/subtle/clear),
seams, tags[], difficulty, quality (1-5) and note. The model does not see the label ("Do not guess the region").
Keep rule: `not no_imagery and quality>=3 and cloud_pct<=5 and forest_pct>=50 and texture!='featureless'`, combined
with the pixel checks. The prompt text is reproduced verbatim in `classify.py` (`PROMPT`). Main points:
- forest_pct is "strict": subtract every bare, cleared, grass or marsh patch, and do not count plantations
- "featureless" means "the only thing you could say is *green* plus one faint line"
- tags only for things "clearly visible that a player would notice; when unsure leave it out", with explicit
  visual definitions (oxbow = cut-off meander lakes/scars; fishbone = parallel side roads off a main road)
- mosaic seams alone are normal; only lower the score if they dominate

## Calibration

| step | set | keep-decision agreement with me | quality MAE |
|---|---|---|---|
| prompt v1 | 90 pilot images | 79% | 0.57 |
| prompt v2 (stricter featureless/forest/cloud wording, seams no longer auto-reject) | 90 pilot | 86% | 0.54 |
| prompt v3 (tightened tag definitions) | 90 pilot | 87% | 0.49 |
| v3 at scale, Haiku keep rule | all 400 | 76% (precision 70%, recall 93%) | |
| v3 + pixel filters (pipeline) | all 400 | precision 75%, recall 93% | |
| Sonnet 5.5, same prompt | 60 random | 87% (precision 82%, recall 93%) | |
| Haiku on the same 60 | 60 random | 83% (precision 76%, recall 97%) | Haiku vs Sonnet 0.43 |

Haiku is a good *recall* filter but not a final judge. About 1 in 4 of its keeps was rejected on review, mostly
flat mosaics it calls "subtle" and small clouds it reports as 0-4%. Sonnet is only modestly better. Their raw
difficulty labels agreed on only 35/60, which is why difficulty is derived from corrected tags instead. **Human review of
every kept sample was necessary**, and it is cheap with 16-up contact sheets.
Claude spend: about $0.60 in total (Haiku plus the Sonnet sample). Static Maps: 400/400 requests (WHO=jungles).

## Distribution

| class | n | z11 | z12 | z13 | z14 | z15 | z16 | easy | medium | hard |
|---|---|---|---|---|---|---|---|---|---|---|
| amazon | 65 | 11 | 11 | 9 | 11 | 10 | 13 | 19 | 31 | 15 |
| congo | 62 | 13 | 12 | 3 | 11 | 10 | 13 | 11 | 37 | 14 |
| seasia | 71 | 17 | 11 | 13 | 12 | 7 | 11 | 33 | 32 | 6 |
| all | 198 | 41 | 34 | 25 | 34 | 27 | 37 | 63 | 100 | 35 |

Subregions (kept / share of class / share of polygon area):
- Amazon: Central 20 (31%/27%), Western 15 (23%/29%), Southern 12 (18%/15%), Eastern 11 (17%/15%), Guiana Shield 7 (11%/15%).
- Congo: Cuvette Centrale 26 (42%/42%), Eastern DRC 14 (23%/20%), Gabon & Eq. Guinea 8 (13%/17%), Cameroon 8 (13%/10%),
  Rep. Congo & SW CAR 6 (10%/10%).
- SE Asia: New Guinea 30 (42%/30%), Borneo 25 (35%/28%), Sumatra 7 (10%/16%), Malay Peninsula 4, Philippines 3, Sulawesi 2,
  Mainland 0. The western islands and the mainland are under-represented because so much of their forest is cleared, which is
  the intended effect of "forest-dominated" filtering. New Guinea is still mostly intact, so it ends up over-represented.

## Gaps and ideas

- Below the 70-80/class target for Amazon (65) and Congo (62), because the request budget is exhausted. The cheapest fix
  is ~60 more requests concentrated at z12, z14 and z15 (Congo z13 yields almost nothing), which should add ~30 keeps.
- Congo z13 is thin (3). The mid-zoom Landsat layer there is nearly always flat, and this is a real property of
  Google's imagery, not a sampling accident. The game may want to avoid z13 for Congo, or accept the imbalance.
- SE Asia hard mode is thin (6). Most SE Asian frames contain relief or roads.
- Mainland SE Asian remnants (Tanintharyi, Cardamoms, Annamites) have no samples; only 2 candidates landed there.
- Small-cloud detection: a dim-cloud detector (local bright blobs relative to the surroundings) would remove most of the
  remaining Haiku false keeps.

## What visually distinguishes the three regions (tips panel material)

The game rotates the view randomly, so none of these tips use north or sun direction.

**Amazon**
- **Rivers are the strongest tell.** There are wide café-au-lait (whitewater) rivers with very regular, tight, looping
  meanders, sandbars on the inside of every bend, and abandoned crescent **oxbow lakes** and scroll-bar ridges beside them.
  None of the other regions has meander belts this clean and repeated. Examples: amazon-008, -018, -063, -075.
- **Blackwater** rivers look almost black. Their flooded side-valleys spread like dark tree roots or fingers (drowned "ria"
  arms), as in amazon-004, -020, -119 and -128, the Rio Negro style.
- **Deforestation is geometric and big.** Ranch pastures are large tan-to-pink rectangles with ruler-straight edges cut
  into dark forest (amazon-014, -019, -056). There are also **fishbone** strips: parallel side roads every few km off a
  straight highway, each one eating clearings into the forest (amazon-046). In the southern arc, clearing follows the
  drainage, leaving dendritic forest "fingers" along the streams (amazon-049).
- Terrain is very flat. Except near the Guiana Shield, you rarely see shaded ridges. Gold-mining (garimpo) scars show
  up as muddy tan pockmarks strung along small streams (amazon-131).
- Up close (z15-16), the canopy is a fine, even, slightly blue-green grain with few giant crowns.

**Congo**
- **Beaded laterite roads.** Thin orange-red dirt roads run for tens of km through forest. Villages are strung along them like
  beads, each wrapped in a narrow fringe of small, irregular, patchwork cassava fields
  (congo-005, -006, -114, -139). Clearings hug the roads and **are small and irregular**, never big rectangles.
- **Forest-savanna mosaic.** Pale tan or khaki grassland with smooth, rounded, lobed edges is interlocked with
  dark forest, and gallery forest runs up the valleys like fingers (congo-048, -087, -129, -136). Savanna sometimes carries round
  pans or termite-mound dots. Amazon has nothing quite like it within the rainforest.
- **The Congo River and its big tributaries** are braided rather than meandering: wide, with many long, thin, vegetated
  islands and pinkish-brown water (congo-022, -062, -120). Smaller rivers are dark and tea-colored, with few oxbows.
- Swamp forest in the central basin looks darker and mottled, with pale marsh patches (Cuvette Centrale).
- **The imagery itself is a clue.** Congo frames are more often hazy, dull olive and low-contrast at mid zooms. Up close,
  the semi-deciduous canopy is speckled with grey-white or bare crowns (congo-018, -058), unlike the uniformly green Amazon.
  Treat this as a soft cue.
- Relief is low and rolling, except in Eastern DRC (Albertine Rift foothills) and the Gabon/Cameroon uplands (congo-130).

**Southeast Asia and New Guinea**
- **Mountains.** The terrain is steep, deeply dissected ridge-and-valley country with strong light/dark shading, sharp ridges
  and V-shaped valleys (seasia-002, -022, -089, -113, -120). Volcanoes with radial ridges also appear (seasia-062, -072).
  Strong relief under rainforest points to SE Asia.
- **Logging-road networks.** Pale winding roads follow the ridgetops and branch like a tree, with log-landing
  clearings at the junctions (seasia-001, -018, -025, -118). They are denser and more contour-hugging than Congo roads.
- **Plantation grids.** Oil palm and acacia appear as perfectly regular blocks, often with straight drainage canals on
  peat, or contour-terraced rows on hills (seasia-011, -033, -073, -100). This is the clearest easy-mode giveaway.
- **Sea is often in frame.** These are islands, so coastlines, mangroves, coral reefs and turquoise lagoons show up
  even in "inland" samples (seasia-016, -022, -049, -085).
- **Rivers** in New Guinea and Borneo's mountains carry white-grey gravel braids (seasia-037, -061, -080). Lowland
  Borneo and New Guinea rivers meander brown through swamp forest (seasia-036).
- Colors are brighter and more yellow-green, with more open-pit mines and tin-roofed villages in valley bottoms.

**Quick decision guide for players**
1. Plantation grid, ridge-top road network, or coastline -> SE Asia.
2. Huge rectangular pastures, fishbone, a clean meander belt with oxbows, or black rias -> Amazon.
3. Beaded red road with patchy fields, rounded savanna patches, or a braided river with long islands -> Congo.
4. Pure canopy: steep shaded relief means SE Asia. A flat, fine, even, blue-green grain means Amazon. Flat, dull olive with grey
   speckled crowns means Congo.
