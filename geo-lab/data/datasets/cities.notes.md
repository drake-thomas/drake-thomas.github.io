# cities.json: notes

City close-up views for the "which country / region is this city?" game.
**287 views of 223 cities in 191 countries/territories**, all within Static Maps zoom 15-17.
I reviewed every kept view by eye. Scope was reduced mid-task to 250-300 kept views and 450
Static Maps requests, down from 600-700 and 950.

| | |
|---|---|
| Static Maps requests (WHO=cities) | 450 / 450 |
| Claude API spend (WHO=cities) | $0.67: 652 Haiku calls plus 71 Sonnet calls for a calibration comparison |
| Candidates fetched | 450: 357 planned, 62 automatic replacements, 31 hand-placed retries |
| Kept | 287 (quality 5: 21, 4: 119, 3: 147; easy 26, medium 164, hard 97) |
| Zooms kept | z15: 42, z16: 167, z17: 78 |

Scripts are in `tools/cities/`, run from the repo root. Intermediates are in `tools/cities/work/`.

1. `pick_cities.py` chooses cities and view candidates and writes `work/candidates.json`.
2. `fetch.py` fetches images under a hard allowance check.
3. `classify.py` holds the Haiku prompt and schema plus the calibrated `passes()` rule.
4. `calib.py` compares Haiku with my pilot ratings.
5. `replace.py` places one automatic replacement for each failed view.
6. `build.py` applies the rule, my overrides (`work/overrides.json`), per-city and per-country caps and the trim step, then writes `data/datasets/cities.json`.

## Selection criteria

**Cities** (Natural Earth `ne_10m_populated_places_simple` joined to `ne_50m_admin_0_countries` on ADM0_A3):
- Every country or territory whose largest place is ≥100k, plus capitals ≥20k. I skipped micro-states and
  tiny territories where a 1-3 km view would be mostly sea or a single village: AND, MCO, SMR, LIE, VAT, TUV, FSM, MHL, PLW, KIR,
  and also NRU, Greenland, the Faroes, N. Cyprus, W. Sahara, Caymans, Bermuda and Aruba.
- I hand-picked 2-3 contrasting cities for large or diverse countries: USA (New York, Phoenix, Atlanta), CHN (Beijing,
  Guangzhou, Chongqing), IND (Delhi, Mumbai, Jaipur), BRA (São Paulo, Fortaleza), RUS (Moscow, Novosibirsk),
  IDN (Jakarta, Surabaya), NGA (Lagos, Kano), MEX (Mexico City, Monterrey), CAN (Toronto, Montréal), AUS (Sydney, Perth).
- 28 "tier B" countries get their largest city plus a second city at least 250 km away, using the capital when it differs.
  Examples: Tokyo/Osaka, Karachi/Islamabad, Casablanca/Marrakesh, Paris/Lyon, Berlin/Munich, Almaty/Astana.
- I overrode bad Natural Earth "largest city" picks. Colombo replaced Jaffna, Kuala Lumpur replaced George Town, and Zürich replaced Geneva.
  Warsaw replaced Katowice, Amsterdam replaced The Hague, and Damascus replaced Aleppo.

**Views:**
- Offset radius R = 1 km × (pop/100k)^0.39, clipped to 0.5-6 km.
- The `core` view sits at 0.1-0.3 R at z16/17 (z17 if pop < 300k). The `res` view sits at 0.55-0.85 R at z15/16 (z16 if pop < 1M).
- Cities under 1M get one `mixed` view at 0.2-0.45 R, z16. Under 300k it is pulled in further, at z17.
- The bearing is chosen so that a 3×3 grid of sample points over the frame falls on land (NE 50m land minus 10m lakes).

**What makes a good view.** I worked this out from the 60-view pilot and the contact sheets.
- Keep views that are **fully urban, crisp, and show the city's ordinary fabric**: blocks, roofs and street pattern.
  The best views carry a regional signature, such as tile-roof grids, Haussmann/Ensanche blocks, mud-brick compounds,
  panel blocks, or terraces with back gardens.
- Reject views that are dominated by one non-residential feature. The common failures were:
  - harbor or sea (Cape Town, Hong Kong, Tel Aviv, Moroni)
  - forest or park on a hill (Mont Royal, Islamabad's Margalla foothills, Chongqing slopes, Bogotá's eastern hills)
  - airfields (Riyadh, Kinshasa, Dakar, Phoenix)
  - highway interchanges (Manzini, Istanbul, Algiers), farmland at the edge (Cali, Karachi), and construction sites (Lomé, Baku)
  - winter or snow imagery that washes everything out (Minsk, Riga, Warsaw)
  - mosaic seams or black no-imagery tiles (Kuwait City z17, Manama)
- Natural Earth points are often 1-5 km off the real downtown, especially for small coastal capitals. Several
  "core" views landed in the sea or in a park. The fix was to hand-place 31 retries on known districts, and all were checked visually.
- z15 works well for big, uniform fabrics (Madrid, Delhi colonies, Surabaya kampungs). Use z17 for small towns, where z16 already shows the fringe.

## Haiku prompt and schema

Model: `claude-haiku-5-5`, effort low, JSON schema output. The full text is `PROMPT` / `SCHEMA` in `tools/cities/classify.py`. Summary:

- The context gives the city, the country and the km across. The model is told to be strict and fills the fields **in order**:
  1. `cues`: one sentence of concrete clues
  2. `distractions`: a phrase with a rough % of the frame
  3. `urban_pct`, `water_pct`, `clouds` (none/light/heavy) and `image_issue` (none/blurry/seam/washed-out/dark)
  4. `quality` 1-5, with anchored definitions (5 = fully urban, crisp, strongly regional; 3 = usable but generic or ≤30% distraction; 2 = a distraction dominates or haze/blur; 1 = not a city)
  5. `difficulty` easy/medium/hard, anchored on what an experienced GeoGuessr player would recognize
  6. 3-6 `tags` from a fixed enum
- Putting `cues` and `distractions` before the numbers helped. In v1 the numbers came first, and the model rated almost
  everything 3-4 and tagged everything with park/highway/red-tile.

Pass rule (`passes()`): `quality ≥ 3 and urban_pct ≥ 50 and water_pct ≤ 30 and clouds != heavy`.

## Calibration

| Stage | Keep/reject agreement with me | Notes |
|---|---|---|
| Pilot v1 prompt (60 views) | 85% | Too lenient: it kept sparse fringe and half-water views |
| Pilot v2 prompt + threshold sweep (60) | **93%** (4 false keeps, 0 false rejects) | Quality exact 68%, within ±1 100% |
| All 388 views I labelled (pilot + QA) | 87% (51 false keeps, 0 false rejects*) | Quality on kept views exact 72%, within ±1 100% |

\*The QA set is mostly views Haiku passed, so false rejects are under-sampled. In the failure sheets I spot-checked, Haiku's rejections looked right.

- Haiku's main systematic error is **leniency on views with 40-50% distraction**: parks, interchanges, rail and industrial land, mountains.
  Its `urban_pct` clusters at 50-60 for both good and bad views, so no threshold separates them.
  I tested a second-stage 4×4-grid "count the urban squares" Haiku prompt. It did no better (best: 9 false keeps with 32 false rejects).
  I also tested Sonnet with the same prompt on 71 labelled views. It was somewhat better (8 false keeps, 4 false rejects at urban ≥ 65), but not enough to replace review.
- So the final filter is Haiku plus my **manual review of all 287 kept views**, done on contact sheets.
  `qa.manual = "reviewed"` on every record, and `quality` is my rating. Haiku's own rating is kept in `qa.haiku_quality`.
- Haiku `difficulty` is mostly "medium". `build.py` maps quality 5 to easy, and quality 3 with low urban cover to hard. Treat difficulty as rough.
- Tags come from Haiku, cleaned up as follows:
  - I dropped park/highway/construction, and dropped `dense-core` on residential views.
  - I added `soviet-microrayon`, `suburban-detached`, `informal-settlement`, `metal-roofs`, `courtyard-blocks`, `high-rise` and `swimming-pools` where I saw them.
    Haiku under-uses these.
  - `left-hand-traffic` was never added. Lane side is not readable at these zooms in static images.

## Coverage (countries per UN subregion; views in parentheses)

| Subregion | Countries | Views |
|---|---|---|
| Eastern Africa | 19: BDI COM DJI ERI ETH KEN MDG MOZ MUS MWI RWA SOL SOM SSD SYC TZA UGA ZMB ZWE | 26 |
| Middle Africa | 9: AGO CAF CMR COD COG GAB GNQ STP TCD | 12 |
| Northern Africa | 6: DZA EGY LBY MAR SDN TUN | 11 |
| Southern Africa | 5: BWA LSO NAM SWZ ZAF | 6 |
| Western Africa | 16: BEN BFA CIV CPV GHA GIN GMB GNB LBR MLI MRT NER NGA SEN SLE TGO | 21 |
| Central Asia | 5: KAZ KGZ TJK TKM UZB | 7 |
| Eastern Asia | 8: CHN HKG JPN KOR MAC MNG PRK TWN | 13 |
| South-Eastern Asia | 11: BRN IDN KHM LAO MMR MYS PHL SGP THA TLS VNM | 18 |
| Southern Asia | 9: AFG BGD BTN IND IRN LKA MDV NPL PAK | 14 |
| Western Asia | 18: ARE ARM AZE BHR CYP GEO IRQ ISR JOR KWT LBN OMN PSE QAT SAU SYR TUR YEM | 27 |
| Eastern Europe | 9: BGR CZE HUN MDA POL ROU RUS SVK UKR | 13 |
| Northern Europe | 10: DNK EST FIN GBR IRL ISL LTU LVA NOR SWE | 16 |
| Southern Europe | 13: ALB BIH ESP GRC HRV ITA KOS MKD MLT MNE PRT SRB SVN | 19 |
| Western Europe | 7: AUT BEL CHE DEU FRA LUX NLD | 13 |
| Caribbean | 15: ATG BHS BRB CUB CUW DMA DOM GRD HTI JAM KNA LCA PRI TTO VCT | 18 |
| Central America | 8: BLZ CRI GTM HND MEX NIC PAN SLV | 14 |
| Northern America | 2: CAN USA | 6 |
| South America | 12: ARG BOL BRA CHL COL ECU GUY PER PRY SUR URY VEN | 22 |
| Australia and New Zealand | 2: AUS NZL | 4 |
| Melanesia | 3: FJI PNG SLB | 3 |
| Micronesia | 1: GUM | 1 |
| Polynesia | 3: PYF TON WSM | 3 |

Subregion and continent come from NE. The "Seven seas" island states are remapped: MDV → Asia, and MUS/SYC/COM → Africa.
Non-ISO codes come from NE's ADM0_A3: `SOL` (Somaliland, Hargeisa) and `KOS` (Kosovo; ISO uses XKX).
Territories are included as their own "country": HKG, MAC, PRI, GUM, PYF, CUW. The game may want to merge them into their parent, or make them subregion-only.

## Gaps

- **Belarus** is missing. All four Minsk tries, at two locations, show winter or snow imagery: washed-out white panel blocks.
  Another location, or z15 in a summer-imagery tile, might work.
- **Vanuatu** is missing. Port Vila views were sparse houses in forest or reef water.
- The micro-states listed above were skipped on purpose.
- Thin regions:
  - Northern America has only 6 views; US suburbs are under-represented, with Atlanta and Phoenix only.
  - Oceania has 11 views in total. Russia has 2 cities, and Siberian or Far East wooden-house towns are absent.
  - China's interior is missing: no Ürümqi or Lhasa.
  - India has no South Indian city.
- Large countries are often down to 1-2 views after the trim step.
  The trim drops quality-3 duplicates when a country has 3 or more views.
- Quality-3 views (147) are usable but generic. A "hard mode" could draw on them, while normal play weights quality 4-5.
- 24 kept views were hand-placed from my knowledge of district locations. Each was checked visually, but they are flagged `qa.view = "hand"`.

## Visual cues by region (for the tips panel)

**Western Europe**
- Closed perimeter blocks with interior courtyards; dark grey slate or zinc roofs in Paris, with star-shaped boulevard intersections.
- Lyon and southern France switch to orange-red tile.
- Low-rise Dutch and Belgian brick terraces run in long parallel rows with narrow back gardens and canals. Amsterdam's ring canals are unmistakable.
- German and Austrian cities have large courtyard blocks with green interiors, wide ring roads, and a mix of red tile and grey roofs.

**Northern Europe**
- In Britain and Ireland, endless terraced rows with long thin back gardens are the British tell.
- Scandinavian capitals have dark grey or black roofs and green courtyards, with water or bare rock nearby.
- Reykjavík: small detached houses with red, blue and green painted metal roofs on treeless ground.
- Baltic capitals: Art Nouveau courtyard blocks, and imagery is often winter-grey.

**Southern Europe**
- Near-universal terracotta tile:
  - Rome, Milan and Lisbon have dense medieval street mazes with courtyards.
  - Madrid and Barcelona have chamfered-corner Ensanche grids, which are distinctive.
- Athens is the exception: a sea of flat white concrete roofs (polykatoikia) packed edge to edge, with rooftop water tanks and solar heaters.
- The Balkans mix red tile with socialist slab blocks, set on hills and rivers.
- Malta: limestone-beige flat roofs in a rigid grid on a peninsula.

**Eastern Europe and Russia**
- Microrayon superblocks: long 5-16 storey slabs set at angles in open green space, with wide avenues. Imagery is often wintry.
- Old centres (Prague, Budapest, Bratislava) are red-tile courtyard blocks like Vienna's.

**Central Asia**
- Soviet slabs on a strict grid with tree-lined avenues, plus one-storey courtyard houses (mahalla) with tin roofs.
- Ashgabat: gleaming white marble towers.
- Snowy mountains or dry steppe at the edges (Almaty, Bishkek).

**Western Asia / Middle East**
- Flat beige or white concrete roofs, rooftop water tanks, dust-colored ground and few trees.
- Riyadh, Kuwait City and Doha have large walled villa plots on wide grids. Older quarters are tight organic mazes:
  Damascus, Sanaa (mud-brown tower houses), Manama's souq.
- Tehran: long north-south plots casting strong parallel shadows, and a very regular grid.
- Gaza: extremely dense grey concrete.
- Beirut and Amman: dense limestone mid-rises on hills.
- The Caucasus (Tbilisi, Yerevan, Baku): red and grey roofs with Soviet blocks, and Yerevan's pink tuff.

**Northern Africa**
- Cairo: endless brown-beige flat-roofed 6-10 storey blocks with unfinished roofs, plus the Nile and its green islands.
- Maghreb cities: white flat roofs.
- Marrakesh: a salmon-pink medina of tiny courtyard houses inside walls.
- Khartoum and Nouakchott: tan one-storey compounds on sandy grids.

**Western Africa (Sahel vs coast)**
- In the Sahel (Kano, Niamey, Ouagadougou, Bamako), mud-brick or concrete compounds have inner yards on red-brown or ochre soil, with few big trees.
  Kano's old city is a dense honeycomb of brown flat roofs.
- On the Gulf of Guinea coast (Lagos, Accra, Lomé, Abidjan), very dense rusted corrugated-metal roofs sit on grey or brown ground.
  There are lagoons and mangroves, haze is common, and red-earth roads appear.

**Middle and Eastern Africa**
- Rusty or grey corrugated metal everywhere, often on an informal grid. Red laterite soil and lots of trees.
- Kinshasa and Brazzaville: endless fine-grained grey metal-roof grids.
- Addis Ababa, Kampala, Kigali: hilly ground with blue-green or rust metal roofs, and eucalyptus.
- Antananarivo: steep hills with red-brick and tile houses beside rice paddies.
- Mogadishu and Hargeisa: whitewashed flat roofs on sandy ground.
- South Sudan (Yei): scattered tukuls and tin roofs on red soil.

**Southern Africa**
- Johannesburg and Harare suburbs: big leafy plots with detached houses, red or grey roofs and blue swimming pools under dense tree canopy.
  Townships, by contrast, are tight grids of tiny matchbox houses.
- Windhoek and Gaborone are dry, with sparse trees.

**Southern Asia**
- Delhi: plotted "colonies" in rectilinear blocks of 3-4 storey flat concrete roofs, with dust haze.
- Mumbai: hazy tight slums beside mangroves.
- Dhaka: extremely dense mid-rise with ponds, always hazy.
- Kathmandu: dense brick-red and grey roofs in a valley with a few green patches.
- Thimphu: colorful pitched roofs on steep green slopes.
- Karachi: beige low-rise, desert haze.
- Kabul: mud-brown houses climbing bare mountains.
- Malé: an entire island covered edge to edge with colorful roofs.

**South-Eastern Asia**
- Bangkok and Saigon: tube-house and shophouse strips with orange, grey and blue roofs, and klongs (canals).
- Hanoi: deep narrow red-roofed tube houses around lakes.
- Indonesia: kampung seas of orange-red tile with dense green between them.
- Manila: very dense corrugated metal, often blue, red or rusty.
- Singapore: HDB slab estates with heavy greenery.
- Phnom Penh: a French-era grid with red tile.

**Eastern Asia**
- Beijing: hutong grey-roof courtyard grids beside huge plazas and high-rise slabs.
- Guangzhou and Hong Kong: dense towers with deep shadows.
- Tokyo and Osaka: an endless fine grain of tiny light-grey and blue roofs, narrow lanes, and elevated expressways.
- Seoul: rows of identical numbered apartment slabs plus forested granite hills.
- Pyongyang: wide avenues and Soviet slabs.
- Ulaanbaatar: Soviet blocks with colorful tin roofs and ger districts.

**Latin America**
- The defining cue is the **tight orthogonal grid of red-tile and concrete roofs** with central plazas:
  Asunción, Santa Cruz, Fortaleza, Guatemala City, San José and Buenos Aires.
- Buenos Aires and Montevideo add mid-rise apartments filling whole blocks.
- Andean and Central American capitals (Bogotá, Caracas, Tegucigalpa) have unpainted brick or grey informal neighbourhoods (barrios) climbing steep slopes around a grid core.
- Lima: dusty grey-beige desert grid with no greenery.
- Mexico City: an enormous grid of flat roofs with blue water tanks.

**Caribbean**
- Colorful tin and red roofs on small detached houses with lush green and hills.
- Havana: a decaying dense colonial grid with courtyard houses, and the Malecón.
- Port-au-Prince: very dense informal housing on hills.
- Santo Domingo and San Juan: grids with flat concrete roofs.

**North America**
- US and Canadian downtowns: rigid grids, big parking lots, freeways.
- Suburbs: curving cul-de-sacs, large detached houses under tree canopy (Atlanta), or desert lots with pools (Phoenix).
- Manhattan: brownstone rows and tower blocks on a dead-straight grid.
- Toronto and Montréal: narrow-lot houses and plexes in long rows with back lanes.

**Oceania**
- Sydney and Perth: red and terracotta tile suburbs on gently curved streets, with lots of pools and backyards.
- Auckland: detached houses among volcanic cones.
- Pacific capitals (Suva, Honiara, Apia, Nuku'alofa, Port Moresby): small scattered houses with blue, red or rust metal roofs,
  dense tropical trees, reef-blue water nearby, and few paved roads.
