/** Static ICAO airport coordinate lookup (fallback for non-SimBrief flights). */
const AIRPORT_COORDS: Record<string, { lat: number; lon: number }> = {
  // --- Europe ---
  EDDF: { lat: 50.0333, lon: 8.5706 },   // Frankfurt
  EDDM: { lat: 48.3538, lon: 11.7861 },   // München
  EDDB: { lat: 52.3667, lon: 13.5033 },   // Berlin Brandenburg
  EDDH: { lat: 53.6304, lon: 9.9882 },    // Hamburg
  EDDK: { lat: 50.8659, lon: 7.1427 },    // Köln/Bonn
  EDDS: { lat: 48.6899, lon: 9.2220 },    // Stuttgart
  EDDL: { lat: 51.2895, lon: 6.7668 },    // Düsseldorf
  EDDW: { lat: 53.0475, lon: 8.7867 },    // Bremen
  EDDN: { lat: 49.4987, lon: 11.0669 },   // Nürnberg
  EDDP: { lat: 51.4324, lon: 12.2416 },   // Leipzig
  EDDC: { lat: 51.1328, lon: 13.7672 },   // Dresden
  EDDE: { lat: 50.9798, lon: 10.9581 },   // Erfurt
  EDDG: { lat: 52.1346, lon: 7.6848 },    // Münster/Osnabrück
  EDDT: { lat: 52.5597, lon: 13.2877 },   // Berlin Tegel (closed but ICAO still used)
  EDDI: { lat: 52.4731, lon: 13.4039 },   // Berlin Tempelhof (historical)
  LOWW: { lat: 48.1103, lon: 16.5697 },   // Wien
  LOWI: { lat: 47.2602, lon: 11.3440 },   // Innsbruck
  LOWG: { lat: 46.9911, lon: 15.4396 },   // Graz
  LOWS: { lat: 47.7933, lon: 13.0043 },   // Salzburg
  LSZH: { lat: 47.4647, lon: 8.5492 },    // Zürich
  LSGG: { lat: 46.2381, lon: 6.1089 },    // Genf
  LSZA: { lat: 46.0040, lon: 8.9106 },    // Lugano
  EGLL: { lat: 51.4700, lon: -0.4543 },   // London Heathrow
  EGKK: { lat: 51.1481, lon: -0.1903 },   // London Gatwick
  EGSS: { lat: 51.8850, lon: 0.2350 },    // London Stansted
  EGLC: { lat: 51.5053, lon: 0.0553 },    // London City
  EGCC: { lat: 53.3537, lon: -2.2750 },   // Manchester
  EGBB: { lat: 52.4539, lon: -1.7480 },   // Birmingham
  EGPH: { lat: 55.9500, lon: -3.3725 },   // Edinburgh
  LFPG: { lat: 49.0097, lon: 2.5478 },    // Paris CDG
  LFPO: { lat: 48.7253, lon: 2.3594 },    // Paris Orly
  LFMN: { lat: 43.6584, lon: 7.2159 },    // Nizza
  LFML: { lat: 43.4393, lon: 5.2214 },    // Marseille
  LFLL: { lat: 45.7256, lon: 5.0811 },    // Lyon
  LFBO: { lat: 43.6291, lon: 1.3678 },    // Toulouse
  EHAM: { lat: 52.3086, lon: 4.7639 },    // Amsterdam Schiphol
  EHRD: { lat: 51.9569, lon: 4.4372 },    // Rotterdam
  EBBR: { lat: 50.9014, lon: 4.4844 },    // Brüssel
  LEMD: { lat: 40.4936, lon: -3.5668 },   // Madrid Barajas
  LEBL: { lat: 41.2971, lon: 2.0785 },    // Barcelona
  LEPA: { lat: 39.5517, lon: 2.7388 },    // Palma de Mallorca
  LEMG: { lat: 36.6749, lon: -4.4991 },   // Málaga
  LEAL: { lat: 38.2822, lon: -0.5582 },   // Alicante
  LPPT: { lat: 38.7813, lon: -9.1359 },   // Lissabon
  LPPR: { lat: 41.2481, lon: -8.6814 },   // Porto
  LIRF: { lat: 41.8003, lon: 12.2389 },   // Rom Fiumicino
  LIMC: { lat: 45.6306, lon: 8.7231 },    // Mailand Malpensa
  LIME: { lat: 45.6739, lon: 9.7042 },    // Bergamo
  LIPZ: { lat: 45.5053, lon: 12.3519 },   // Venedig
  LIRN: { lat: 40.8861, lon: 14.2908 },   // Neapel
  LGAV: { lat: 37.9364, lon: 23.9445 },   // Athen
  LGTS: { lat: 40.5197, lon: 22.9709 },   // Thessaloniki
  LGIR: { lat: 35.3397, lon: 25.1803 },   // Heraklion/Kreta
  LTFM: { lat: 41.2753, lon: 28.7519 },   // Istanbul
  LTAI: { lat: 36.8987, lon: 30.8005 },   // Antalya
  LTBA: { lat: 40.9769, lon: 28.8146 },   // Istanbul Atatürk
  EKCH: { lat: 55.6180, lon: 12.6561 },   // Kopenhagen
  ENGM: { lat: 60.1939, lon: 11.1004 },   // Oslo Gardermoen
  ESSA: { lat: 59.6519, lon: 17.9186 },   // Stockholm Arlanda
  EFHK: { lat: 60.3172, lon: 24.9633 },   // Helsinki
  EPWA: { lat: 52.1657, lon: 20.9671 },   // Warschau
  LKPR: { lat: 50.1008, lon: 14.2600 },   // Prag
  LHBP: { lat: 47.4369, lon: 19.2556 },   // Budapest
  LROP: { lat: 44.5711, lon: 26.0850 },   // Bukarest
  LDZA: { lat: 45.7429, lon: 16.0688 },   // Zagreb
  LJLJ: { lat: 46.2237, lon: 14.4576 },   // Ljubljana
  LYBE: { lat: 44.8184, lon: 20.3091 },   // Belgrad
  LWSK: { lat: 41.9616, lon: 21.6214 },   // Skopje
  LATI: { lat: 41.4147, lon: 19.7206 },   // Tirana
  BKPR: { lat: 42.5728, lon: 21.0358 },   // Pristina
  LBSF: { lat: 42.6952, lon: 23.4114 },   // Sofia
  UKBB: { lat: 50.3450, lon: 30.8947 },   // Kiew Boryspil
  UMMS: { lat: 53.8825, lon: 28.0308 },   // Minsk
  EVRA: { lat: 56.9236, lon: 23.9711 },   // Riga
  EYVI: { lat: 54.6341, lon: 25.2858 },   // Vilnius
  EETN: { lat: 59.4133, lon: 24.8328 },   // Tallinn
  BIKF: { lat: 63.9850, lon: -22.6056 },  // Keflavik/Island
  EIDW: { lat: 53.4213, lon: -6.2701 },   // Dublin

  // --- Nordamerika ---
  KJFK: { lat: 40.6413, lon: -73.7781 },  // New York JFK
  KLGA: { lat: 40.7772, lon: -73.8726 },  // New York LaGuardia
  KEWR: { lat: 40.6925, lon: -74.1687 },  // Newark
  KLAX: { lat: 33.9425, lon: -118.4081 }, // Los Angeles
  KORD: { lat: 41.9742, lon: -87.9073 },  // Chicago O'Hare
  KATL: { lat: 33.6407, lon: -84.4277 },  // Atlanta
  KDFW: { lat: 32.8998, lon: -97.0403 },  // Dallas/Fort Worth
  KDEN: { lat: 39.8561, lon: -104.6737 }, // Denver
  KSFO: { lat: 37.6213, lon: -122.3790 }, // San Francisco
  KSEA: { lat: 47.4502, lon: -122.3088 }, // Seattle
  KMIA: { lat: 25.7959, lon: -80.2870 },  // Miami
  KBOS: { lat: 42.3656, lon: -71.0096 },  // Boston
  KPHL: { lat: 39.8721, lon: -75.2411 },  // Philadelphia
  KMSP: { lat: 44.8848, lon: -93.2223 },  // Minneapolis
  KDTW: { lat: 42.2124, lon: -83.3534 },  // Detroit
  KIAH: { lat: 29.9844, lon: -95.3414 },  // Houston
  KLAS: { lat: 36.0840, lon: -115.1537 }, // Las Vegas
  KMCO: { lat: 28.4294, lon: -81.3090 },  // Orlando
  KPHX: { lat: 33.4373, lon: -112.0078 }, // Phoenix
  KCLT: { lat: 35.2140, lon: -80.9431 },  // Charlotte
  KDCA: { lat: 38.8512, lon: -77.0402 },  // Washington Reagan
  KIAD: { lat: 38.9445, lon: -77.4558 },  // Washington Dulles
  CYYZ: { lat: 43.6777, lon: -79.6248 },  // Toronto Pearson
  CYUL: { lat: 45.4706, lon: -73.7408 },  // Montreal
  CYVR: { lat: 49.1967, lon: -123.1815 }, // Vancouver
  MMMX: { lat: 19.4363, lon: -99.0721 },  // Mexico City

  // --- Asien ---
  VHHH: { lat: 22.3080, lon: 113.9185 },  // Hong Kong
  RJTT: { lat: 35.5523, lon: 139.7798 },  // Tokyo Haneda
  RJAA: { lat: 35.7647, lon: 140.3864 },  // Tokyo Narita
  RKSI: { lat: 37.4602, lon: 126.4407 },  // Seoul Incheon
  WSSS: { lat: 1.3502, lon: 103.9944 },   // Singapur Changi
  VTBS: { lat: 13.6900, lon: 100.7501 },  // Bangkok Suvarnabhumi
  WIII: { lat: -6.1256, lon: 106.6558 },  // Jakarta
  RPLL: { lat: 14.5086, lon: 121.0198 },  // Manila
  VABB: { lat: 19.0887, lon: 72.8679 },   // Mumbai
  VIDP: { lat: 28.5562, lon: 77.1000 },   // Delhi
  ZBAA: { lat: 40.0799, lon: 116.6031 },  // Peking
  ZSPD: { lat: 31.1443, lon: 121.8083 },  // Shanghai Pudong
  ZGGG: { lat: 23.3924, lon: 113.2988 },  // Guangzhou
  RCTP: { lat: 25.0777, lon: 121.2325 },  // Taipei
  WMKK: { lat: 2.7456, lon: 101.7099 },   // Kuala Lumpur
  OMDB: { lat: 25.2528, lon: 55.3644 },   // Dubai
  OEJN: { lat: 21.6796, lon: 39.1565 },   // Jeddah
  OERK: { lat: 24.9576, lon: 46.6988 },   // Riad
  OTHH: { lat: 25.2731, lon: 51.6081 },   // Doha
  OMAA: { lat: 24.4330, lon: 54.6511 },   // Abu Dhabi
  OBBI: { lat: 26.2708, lon: 50.6336 },   // Bahrain
  OKBK: { lat: 29.2266, lon: 47.9689 },   // Kuwait
  OIIE: { lat: 35.4161, lon: 51.1522 },   // Teheran
  OLBA: { lat: 33.8209, lon: 35.4884 },   // Beirut
  LLBG: { lat: 32.0114, lon: 34.8867 },   // Tel Aviv

  // --- Afrika ---
  FAOR: { lat: -26.1392, lon: 28.2460 },  // Johannesburg
  FACT: { lat: -33.9649, lon: 18.6017 },  // Kapstadt
  HECA: { lat: 30.1219, lon: 31.4056 },   // Kairo
  GMMN: { lat: 33.3675, lon: -7.5898 },   // Casablanca
  DNMM: { lat: 6.5774, lon: 3.3213 },     // Lagos
  HKJK: { lat: -1.3192, lon: 36.9278 },   // Nairobi
  HAAB: { lat: 8.9779, lon: 38.7993 },    // Addis Abeba
  DTTA: { lat: 36.8510, lon: 10.2272 },   // Tunis

  // --- Südamerika ---
  SBGR: { lat: -23.4356, lon: -46.4731 }, // São Paulo Guarulhos
  SCEL: { lat: -33.3930, lon: -70.7858 }, // Santiago
  SAEZ: { lat: -34.8222, lon: -58.5358 }, // Buenos Aires Ezeiza
  SKBO: { lat: 4.7016, lon: -74.1469 },   // Bogotá
  SPJC: { lat: -12.0219, lon: -77.1143 }, // Lima

  // --- Ozeanien ---
  YSSY: { lat: -33.9461, lon: 151.1772 }, // Sydney
  YMML: { lat: -37.6733, lon: 144.8433 }, // Melbourne
  NZAA: { lat: -37.0082, lon: 174.7850 }, // Auckland
};

export function getAirportCoords(icao: string): { lat: number; lon: number } | undefined {
  return AIRPORT_COORDS[icao.toUpperCase()];
}
