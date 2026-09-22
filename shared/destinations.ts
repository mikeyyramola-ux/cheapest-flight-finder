/**
 * Single source of truth for airports / destinations.
 * Used by the Home search dropdown (client), the programmatic
 * /flights-to/:slug destination pages (client + SSR head), and the sitemap.
 */

export type AirportOption = { code: string; city: string; country: string; airport: string };

export type Destination = AirportOption & {
  /** URL segment, e.g. "sao-paulo". Derived from the city name. */
  slug: string;
  region: string;
  /** Unique long-form copy for the destination page body. */
  blurb: string;
  /** Unique best-time-to-fly copy for the destination page body. */
  season: string;
};

type DestinationInput = AirportOption & { region: string; blurb: string; season: string };

/** ASCII slug from a city name: "São Paulo" -> "sao-paulo". */
const slugify = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const RAW: DestinationInput[] = [
  { code: "JFK", city: "New York", country: "United States", airport: "John F. Kennedy International", region: "North America",
    blurb: "New York is the most-searched long-haul gateway in the United States, with John F. Kennedy International handling the bulk of transatlantic traffic alongside LaGuardia and Newark. Fareloop compares total prices across carriers on JFK routes, so you see the real cost including stops and baggage.",
    season: "Fall and early spring offer the best balance of price and weather. Summer and the December holiday period are peak; book two to six months ahead for transatlantic seats and watch the 90-day trend for dips." },
  { code: "LAX", city: "Los Angeles", country: "United States", airport: "Los Angeles International", region: "North America",
    blurb: "Los Angeles International anchors the busiest transpacific and Latin American market on the US West Coast, with heavy competition between carriers on every long-haul route. That competition is what produces fare drops — Fareloop watches LAX prices continuously so you can book when the curve dips.",
    season: "January through March and late September to November usually carry the lowest fares. Avoid school-holiday weeks in July and August, when nonstop demand pushes prices up across the Pacific and to Latin America." },
  { code: "SFO", city: "San Francisco", country: "United States", airport: "San Francisco International", region: "North America",
    blurb: "San Francisco International is the Bay Area's main long-haul hub, strong on transpacific routes to Tokyo, Hong Kong, and Singapore as well as domestic shuttles to LA and New York. SFO fares swing with midweek business demand, which creates predictable dip windows.",
    season: "Late winter and fall bring the softest fares. Tuesday-to-Thursday departures are consistently cheaper than weekend legs; watch the SFO trend line and book roughly one to three months out for domestic hops." },
  { code: "ORD", city: "Chicago", country: "United States", airport: "O'Hare International", region: "North America",
    blurb: "Chicago O'Hare is one of the largest connecting hubs in the world, so ORD is a natural pick for one-stop itineraries almost anywhere. Nonstop options are wide, and the sheer number of carriers competing on ORD routes keeps fares contestable.",
    season: "April to June and September to October balance good weather with lower fares. January and February can be cheap but storm-prone, and late December is peak; book domestic trips one to three months ahead." },
  { code: "YYZ", city: "Toronto", country: "Canada", airport: "Pearson International", region: "North America",
    blurb: "Toronto Pearson handles the largest share of Canadian long-haul traffic, with strong transatlantic and Latin American competition. Pearson is also a major connecting point for flights into northern and coastal Canada, making YYZ a useful origin when comparing one-stop versus nonstop value.",
    season: "Fly in April to May or late September to November for the best combination. Summer is peak for families and December holidays are expensive; winter can be cheap, so check baggage rules and connection risk in snow season." },
  { code: "YVR", city: "Vancouver", country: "Canada", airport: "Vancouver International", region: "North America",
    blurb: "Vancouver International is Canada's gateway to Asia, with quick nonstop runs to Tokyo, Seoul, Beijing, Hong Kong, and Taipei plus dense US transborder traffic. YVR's geographic position often makes it the cheapest Canadian origin for Pacific routes.",
    season: "January to March and October offer the softest transpacific fares. Summer is peak for leisure demand to Asia; aim to book two to five months ahead and use flexible-date search to catch midweek dips." },
  { code: "LHR", city: "London", country: "United Kingdom", airport: "Heathrow", region: "Europe",
    blurb: "London Heathrow is Europe's busiest long-haul airport and the most competitive transatlantic market in the world, with multiple carriers flying every major US and Middle Eastern route. That rivalry is why London fares drop often — and why watching the trend pays off.",
    season: "January to March and late autumn carry the lowest fares, with May and June as shoulder-season sweet spots. July, August, and the Christmas period peak; transatlantic seats are cheapest two to five months out." },
  { code: "CDG", city: "Paris", country: "France", airport: "Charles de Gaulle", region: "Europe",
    blurb: "Paris Charles de Gaulle connects to more than 300 destinations and is a prime gateway to continental Europe, North Africa, and the French overseas territories. Competition between legacy carriers and low-cost operators on CDG routes keeps fares moving in both directions.",
    season: "February to early June and September to November are the value windows. Major summer events and the August holiday exodus push prices up; book two to six months ahead for intercontinental travel." },
  { code: "AMS", city: "Amsterdam", country: "Netherlands", airport: "Schiphol", region: "Europe",
    blurb: "Amsterdam Schiphol is a compact, efficient hub with one of the widest route networks in Europe, making it a favorite for one-stop itineraries into Europe, Asia, and Africa. Dense carrier competition on AMS routes produces frequent, short-lived fare dips.",
    season: "March to May and September to October are cheapest and pleasant. Tulip season in April raises leisure demand slightly and December is peak; watch the 90-day trend and book one to four months out." },
  { code: "FRA", city: "Frankfurt", country: "Germany", airport: "Frankfurt Airport", region: "Europe",
    blurb: "Frankfurt is continental Europe's leading long-haul hub, with exceptional connections to Germany, Central Europe, and intercontinental destinations. As a primary hub for a major alliance, FRA rewards travelers who compare nonstop fares against cheaper one-stop alternatives.",
    season: "November to March, outside the Christmas weeks, is the low season for fares. Business traffic keeps midweek seats pricier while leisure-heavy weekends dip; book one to four months ahead and stay flexible on the return day." },
  { code: "MAD", city: "Madrid", country: "Spain", airport: "Adolfo Suárez Madrid–Barajas", region: "Europe",
    blurb: "Madrid Barajas is Spain's largest airport and the main bridge between Europe and Latin America, with unusually strong coverage of South American cities. That route depth makes MAD a smart origin for multi-country itineraries and a place where long-haul fares compete hard.",
    season: "January to March and October to November bring the lowest fares. Semana Santa and summer are peak; shoulder-season spring and autumn pair fair prices with the best weather. Book two to five months ahead." },
  { code: "FCO", city: "Rome", country: "Italy", airport: "Leonardo da Vinci–Fiumicino", region: "Europe",
    blurb: "Rome Fiumicino serves Italy's biggest tourism market, with dense European short-haul coverage and strong links to North America, the Middle East, and Brazil. Leisure demand makes FCO seasonal in pricing, so timing matters more here than on business-heavy routes.",
    season: "April to June and September to October pair fair fares with good weather. August is peak Italian holiday season and winter is cheapest outside the holidays; intercontinental seats reward booking two to six months out." },
  { code: "IST", city: "Istanbul", country: "Türkiye", airport: "Istanbul Airport", region: "Europe",
    blurb: "Istanbul Airport has become one of the world's largest connecting hubs, spanning Europe, Asia, Africa, and the Americas behind a single mega-carrier. IST often wins on price for one-stop itineraries that would otherwise cost far more as a nonstop.",
    season: "January to March and November outside school breaks are the cheapest windows. Summer and the Eid travel periods spike, while spring and autumn are ideal in the city itself; book two to four months ahead for long-haul." },
  { code: "DXB", city: "Dubai", country: "United Arab Emirates", airport: "Dubai International", region: "Middle East",
    blurb: "Dubai International is one of the world's leading international passenger airports and the default connection between Europe, Asia, Africa, and Oceania. DXB fares are shaped by one dominant carrier plus Gulf rivals, so differences between dates on the same route can be large.",
    season: "May to early June and September to November are the value seasons; June to August is hot but cheap, and December to February peaks on leisure demand. Watch trends rather than fixed windows — DXB prices move fast." },
  { code: "DOH", city: "Doha", country: "Qatar", airport: "Hamad International", region: "Middle East",
    blurb: "Doha's Hamad International is a fast-rising Gulf hub with a single high-rated carrier offering extensive one-stop reach to Asia, Africa, Europe, and Oceania. DOH connections frequently undercut nonstop fares on the same city pairs by a wide margin.",
    season: "November to March brings comfortable weather but higher leisure demand; the cheapest fares usually appear from June to August and in late September. Book long-haul one-stops two to five months out and compare DOH against DXB." },
  { code: "AUH", city: "Abu Dhabi", country: "United Arab Emirates", airport: "Zayed International", region: "Middle East",
    blurb: "Abu Dhabi's Zayed International competes directly with neighboring Dubai, often producing lower one-stop fares to Asia, Africa, and Europe on similar routings. The airport is smaller and calmer, which some travelers prefer for long connections between continents.",
    season: "October to April is peak season for the emirate while June to September carries the lowest fares. Compare AUH and DXB on the same dates — the neighboring airports frequently differ by more than 20% on identical routes." },
  { code: "JNB", city: "Johannesburg", country: "South Africa", airport: "O.R. Tambo International", region: "Africa",
    blurb: "O.R. Tambo International is southern Africa's main gateway and the region's busiest airport, connecting to Europe, the Middle East, Asia, and domestic centers across South Africa. JNB is also the usual springboard for trips to Cape Town, Durban, and the wider region.",
    season: "September to November and February to March balance fare and weather outside the southern summer rush. June to August is winter low season on many routes while December holidays peak; book two to five months ahead for intercontinental travel." },
  { code: "CAI", city: "Cairo", country: "Egypt", airport: "Cairo International", region: "Africa",
    blurb: "Cairo International connects the Nile delta to Europe, the Gulf, Africa, and Asia, and it is the practical entry point for Egypt plus onward Red Sea and North African trips. Mixed carrier competition keeps CAI fares contestable, especially on European short-haul.",
    season: "October to April is the comfortable season, with the softest fares typically January to March outside the holidays. Summer heat suppresses leisure demand and prices while December peaks; book one to four months out." },
  { code: "BOM", city: "Mumbai", country: "India", airport: "Chhatrapati Shivaji Maharaj", region: "Asia",
    blurb: "Mumbai's Chhatrapati Shivaji Maharaj International is India's busiest airport and its financial capital's gateway, with dense domestic competition and strong Middle Eastern and European connections. The heavy carrier count on BOM routes is what creates regular fare sales.",
    season: "January to March and the post-monsoon months of September to November carry the best fares. Summer and Diwali periods peak; monsoon months can be cheapest but bring rain delays. Book domestic trips one to three months ahead." },
  { code: "DEL", city: "New Delhi", country: "India", airport: "Indira Gandhi International", region: "Asia",
    blurb: "Indira Gandhi International is India's largest airport and a mega-hub for domestic connections, with extensive one-stop reach to North America, Europe, and Oceania. DEL sees intense price competition, and flexible-date searches regularly uncover fares well below the route average.",
    season: "February to April and September to November offer fair weather and good fares. The December to January holiday period is peak, the July monsoon window often cheapest; intercontinental seats reward booking three to six months out." },
  { code: "HND", city: "Tokyo", country: "Japan", airport: "Haneda", region: "Asia",
    blurb: "Tokyo Haneda is Japan's primary airport for domestic traffic and increasingly for international short and medium haul, sitting closer to central Tokyo than Narita. HND fares to the rest of Asia are highly competitive, and Haneda is usually worth the small premium over Narita.",
    season: "January to March and October to November bring the lowest fares and good weather. Cherry-bloom late March to April and late December peak; June to August is humid and cheaper. Book two to five months ahead." },
  { code: "ICN", city: "Seoul", country: "South Korea", airport: "Incheon International", region: "Asia",
    blurb: "Incheon International consistently ranks among the world's best airports and serves as a strong Asia-Pacific connecting hub with excellent one-stop options to North America and Southeast Asia. ICN fares respond quickly to carrier sales, so short-lived dips are common.",
    season: "March to May and September to November are the value seasons. Summer monsoon and the Chuseok holiday shift prices, and winter except New Year is usually cheapest; compare midweek departures and book one to four months out." },
  { code: "PEK", city: "Beijing", country: "China", airport: "Capital International", region: "Asia",
    blurb: "Beijing Capital International is a major gateway to northern China, with extensive domestic connections and long-haul service to Europe, the Middle East, and the Americas. Returning capacity and carrier competition continue to push PEK fares down on trunk routes.",
    season: "March to May and September to early November pair fair fares with the best weather. Chinese New Year and Golden Week peak sharply while winter is cheapest; book two to five months ahead and avoid holiday blocks." },
  { code: "HKG", city: "Hong Kong", country: "Hong Kong", airport: "Hong Kong International", region: "Asia",
    blurb: "Hong Kong International is one of Asia's premier connecting airports, ideally placed for one-stop trips into mainland China and Southeast Asia plus long-haul routes to Europe and the Americas. Fierce carrier competition has kept HKG fares aggressive across the region.",
    season: "October to December and February to March are the pleasant, cheaper windows. Summer typhoon season and Chinese New Year peak; June to August can dip despite holidays elsewhere. Book one to four months out and check flexible dates." },
  { code: "BKK", city: "Bangkok", country: "Thailand", airport: "Suvarnabhumi", region: "Asia",
    blurb: "Suvarnabhumi is Southeast Asia's busiest connecting airport and the launch point for Thailand's islands plus onward trips across the region. BKK carries enormous leisure demand, which makes timing the difference between an average fare and a genuinely cheap one.",
    season: "November to February is peak season with higher fares; the cheapest window is usually May to October during monsoon, with June and September particularly soft. March to May is hot and moderately priced. Book two to four months ahead." },
  { code: "SIN", city: "Singapore", country: "Singapore", airport: "Changi", region: "Asia",
    blurb: "Changi Airport is Asia's benchmark hub, connecting efficiently to Australia, New Zealand, India, Europe, and the Americas with a world-class layover experience. SIN is often the cheapest one-stop option for routes where a nonstop would cost far more.",
    season: "February to April and the late-year shoulder usually carry the fairest fares while June and December holidays peak. There is no cold season, so use the 90-day trend instead of the calendar — SIN fares move with seat sales." },
  { code: "SYD", city: "Sydney", country: "Australia", airport: "Kingsford Smith", region: "Oceania",
    blurb: "Kingsford Smith serves Australia's largest city and the country's busiest international market, with heavy competition on Trans-Tasman, Asian, and long-haul routes to Europe and the Americas. Sydney is also the common comparison point against Melbourne for the best Australia fare.",
    season: "March to May and September to November bring shoulder-season fares and good weather. December to February and the January school holidays peak, while June to August is winter and often cheapest; book three to six months ahead for long haul." },
  { code: "AKL", city: "Auckland", country: "New Zealand", airport: "Auckland Airport", region: "Oceania",
    blurb: "Auckland Airport is New Zealand's main international gateway and the natural entry for both islands, with strong Trans-Tasman links to Australia and long-haul routes to the Americas, Asia, and the Middle East. AKL fares swing heavily with seasonal demand.",
    season: "March to May and September to November are the value windows. December to February summer and the Christmas period peak sharply while June to August is winter low season; intercontinental fares reward booking three to six months ahead." },
  { code: "MEX", city: "Mexico City", country: "Mexico", airport: "Benito Juárez International", region: "North America",
    blurb: "Benito Juárez International is one of Latin America's busiest airports by passengers, anchoring domestic traffic and strong US and Latin American connections. MEX is the gateway for central Mexico, and dense low-cost competition keeps domestic fares among the region's most contestable.",
    season: "January to May outside Easter week and October to November carry the best fares. Summer, Christmas, and the August long weekend peak, while rainy-season months suppress some leisure demand; book one to four months out." },
  { code: "GRU", city: "São Paulo", country: "Brazil", airport: "Guarulhos International", region: "South America",
    blurb: "Guarulhos International is South America's leading international airport and Brazil's business gateway, with unrivalled reach across the continent. GRU is often the cheapest Brazilian entry point, with onward domestic connections to Rio, Salvador, and the beach resorts.",
    season: "March to May and August to November bring fairer fares outside Carnival and the December holidays. June to July winter is typically cheapest — Carnival dates move, so book far ahead if traveling then, otherwise watch the trend." },
  { code: "EZE", city: "Buenos Aires", country: "Argentina", airport: "Ministro Pistarini", region: "South America",
    blurb: "Ministro Pistarini (Ezeiza) serves Buenos Aires with competitive transatlantic and regional service, including strong links to Brazil, Chile, and Europe. EZE fares respond quickly to airline sales, so flexible-date searches regularly find fares well under the route average.",
    season: "September to November and March to May pair shoulder-season fares with the best weather. December to February southern summer is peak, June to August winter usually cheapest; book two to five months ahead for Europe-bound trips." },
  { code: "SCL", city: "Santiago", country: "Chile", airport: "Arturo Merino Benítez", region: "South America",
    blurb: "Arturo Merino Benítez serves Santiago and is the main hub for travel across Chile, connecting onward to Easter Island, Patagonia, and Argentina. SCL benefits from competition on long-haul routes to both North America and Europe, keeping fares contestable.",
    season: "March to May and September to November are the value seasons. December to February southern summer and the January school break peak, while June to August winter is cheapest; book two to five months ahead for intercontinental flights." },
];

export const DESTINATIONS: Destination[] = RAW.map(d => ({ ...d, slug: slugify(d.city) }));

/** Search-dropdown shape used by the Home airport fields (stable field order). */
export const airportOptions: AirportOption[] = DESTINATIONS.map(({ code, city, country, airport }) => ({ code, city, country, airport }));

const bySlug = new Map(DESTINATIONS.map(d => [d.slug, d]));
const byCode = new Map(DESTINATIONS.map(d => [d.code, d]));

export const destinationBySlug = (slug: string): Destination | undefined => bySlug.get(slug);
export const destinationByCode = (code: string): Destination | undefined => byCode.get(code);
/** Canonical path for a destination page. */
export const destinationPath = (slug: string): string => `/flights-to/${slug}`;
export const DESTINATION_PATHS: string[] = DESTINATIONS.map(d => destinationPath(d.slug));

/** Region order used to group destination links on hub and city pages. */
export const DESTINATION_REGIONS: string[] = Array.from(new Set(DESTINATIONS.map(d => d.region)));

/** Major origin airports surfaced as "flights from X" links on every destination page. */
export const POPULAR_ORIGIN_HUBS: string[] = ["JFK", "LHR", "LAX", "DXB", "SIN", "FRA"];

export const hubLabel = (code: string): string => destinationByCode(code)?.city ?? code;
