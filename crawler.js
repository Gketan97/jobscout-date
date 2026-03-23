/**
 * JobScout India — GitHub Actions Crawler
 * =========================================
 * Runs every 4 hours via GitHub Actions.
 * Writes data/jobs.json and data/meta.json to the repo.
 * Served to all users via jsDelivr CDN — zero per-user fetching.
 *
 * Sources:
 *   1. Greenhouse   — direct API, all jobs in one call
 *   2. Lever        — direct API, all jobs in one call
 *   3. Ashby        — direct API, all jobs in one call
 *   4. Workable     — paginated (offset), 50/page
 *   5. SmartRecruiters — paginated (offset), 100/page, country=IN filter
 *   6. Eightfold    — paginated (cursor), 10/page, location=India filter
 *   7. Adzuna       — company-specific queries for MNCs, city queries for broad coverage
 *
 * India Classification (5 layers):
 *   L1 — Explicit India city/state in location → KEEP (high confidence)
 *   L2 — Explicit non-India city/country in location → DROP
 *   L3 — Blank/remote + T1/T2 company → KEEP (Indian company, assume India)
 *   L4 — Blank/remote + T3/T4 company → DROP (MNC/global, too ambiguous)
 *   L5 — Adzuna with India query / SmartRecruiters country=IN / Eightfold location=India → KEEP (100% India)
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// ── SECRETS ──────────────────────────────────────────────────────────────────
const ADZUNA_ID  = process.env.ADZUNA_APP_ID  || '';
const ADZUNA_KEY = process.env.ADZUNA_APP_KEY || '';
const JSEARCH_KEY = process.env.JSEARCH_KEY   || '';

// ── COMPANIES ─────────────────────────────────────────────────────────────────

const GREENHOUSE = [
  // T1 — Indian Unicorns
  { n:'Razorpay',     t:1, ind:'fintech',    c:'#2666CF', s:'razorpaysoftwareprivatelimited' },
  { n:'PhonePe',      t:1, ind:'fintech',    c:'#5F4BB6', s:'phonepe'                        },
  { n:'Groww',        t:1, ind:'fintech',    c:'#5367FF', s:'groww'                          },
  { n:'InMobi',       t:1, ind:'adtech',     c:'#F7941D', s:'inmobi'                         },
  { n:'Zepto',        t:1, ind:'food',       c:'#AA33FF', s:'zepto'                          },
  { n:'Nykaa',        t:1, ind:'ecommerce',  c:'#E91E8C', s:'nykaa'                          },
  { n:'Swiggy',       t:1, ind:'food',       c:'#FC8019', s:'swiggy'                         },
  { n:'Zomato',       t:1, ind:'food',       c:'#E23744', s:'zomato'                         },
  { n:'Dream11',      t:1, ind:'gaming',     c:'#1A73E8', s:'dream11'                        },
  { n:'Delhivery',    t:1, ind:'logistics',  c:'#D8232A', s:'delhivery'                      },
  { n:'PolicyBazaar', t:1, ind:'insurance',  c:'#F47920', s:'policybazaar'                   },
  { n:'PharmEasy',    t:1, ind:'healthtech', c:'#00B374', s:'pharmeasy'                      },
  { n:'Moglix',       t:1, ind:'b2b',        c:'#FF6B00', s:'moglix'                         },
  // T2 — Indian Startups
  { n:'Porter',       t:2, ind:'logistics',  c:'#FF6B35', s:'porter'                         },
  { n:'Juspay',       t:2, ind:'fintech',    c:'#2D5BE3', s:'juspay'                         },
  { n:'Cashfree',     t:2, ind:'fintech',    c:'#0EA5E9', s:'cashfree'                       },
  { n:'Smallcase',    t:2, ind:'fintech',    c:'#4CAF50', s:'smallcase'                      },
  { n:'KreditBee',    t:2, ind:'fintech',    c:'#FF6B2C', s:'kreditbee'                      },
  { n:'Cars24',       t:2, ind:'ecommerce',  c:'#E5322C', s:'cars24'                         },
  { n:'Spinny',       t:2, ind:'ecommerce',  c:'#FF4B00', s:'spinny'                         },
  { n:'Shiprocket',   t:2, ind:'logistics',  c:'#FF6B35', s:'shiprocket'                     },
  { n:'Innovaccer',   t:2, ind:'healthtech', c:'#1976D2', s:'innovaccer'                     },
  { n:'MoEngage',     t:2, ind:'adtech',     c:'#1DA0E0', s:'moengage'                       },
  { n:'LambdaTest',   t:2, ind:'saas',       c:'#FF7043', s:'lambdatest'                     },
  { n:'Sprinklr',     t:2, ind:'saas',       c:'#1976D2', s:'sprinklr'                       },
  { n:'Darwinbox',    t:2, ind:'hrtech',     c:'#2563EB', s:'darwinbox'                      },
  { n:'LeadSquared',  t:2, ind:'saas',       c:'#FF6B00', s:'leadsquared'                    },
  { n:'Whatfix',      t:2, ind:'saas',       c:'#FF6B35', s:'whatfix'                        },
  { n:'Zerodha',      t:2, ind:'fintech',    c:'#387ED1', s:'zerodha'                        },
  { n:'BharatPe',     t:2, ind:'fintech',    c:'#22C55E', s:'bharatpe'                       },
  { n:'Perfios',      t:2, ind:'fintech',    c:'#00897B', s:'perfios'                        },
  { n:'Moneyview',    t:2, ind:'fintech',    c:'#2196F3', s:'moneyview'                      },
  { n:'KreditBee',    t:2, ind:'fintech',    c:'#FF6B2C', s:'kreditbee'                      },
  { n:'Lenskart',     t:2, ind:'ecommerce',  c:'#00BFFF', s:'lenskart'                       },
  { n:'BlackBuck',    t:2, ind:'logistics',  c:'#1A1A2E', s:'blackbuck'                      },
  { n:'Dunzo',        t:2, ind:'ecommerce',  c:'#FF6B35', s:'dunzo'                          },
  { n:'HealthifyMe',  t:2, ind:'healthtech', c:'#10B981', s:'healthifyme'                    },
  { n:'Cure.fit',     t:2, ind:'healthtech', c:'#FF4081', s:'curefit'                        },
  { n:'Urban Company',t:2, ind:'services',   c:'#5046E5', s:'urbancompany'                   },
  { n:'Acko',         t:1, ind:'insurance',  c:'#F85C50', s:'acko'                           },
  { n:'Digit',        t:1, ind:'insurance',  c:'#FF5A1F', s:'digit'                          },
  { n:'Innoviti',     t:2, ind:'fintech',    c:'#003087', s:'innoviti'                       },
  { n:'Mintifi',      t:2, ind:'fintech',    c:'#00BCD4', s:'mintifi'                        },
  { n:'Ninjacart',    t:2, ind:'agritech',   c:'#FF6B00', s:'ninjacart'                      },
  { n:'DeHaat',       t:2, ind:'agritech',   c:'#388E3C', s:'dehaat'                         },
  { n:'Zetwerk',      t:1, ind:'b2b',        c:'#FF6B00', s:'zetwerk'                        },
  { n:'Vedantu',      t:2, ind:'edtech',     c:'#562FBC', s:'vedantu'                        },
  { n:'upGrad',       t:2, ind:'edtech',     c:'#FF5252', s:'upgrad'                         },
  { n:'Testbook',     t:2, ind:'edtech',     c:'#00A651', s:'testbook'                       },
  { n:'Eruditus',     t:2, ind:'edtech',     c:'#1A1A2E', s:'eruditus'                       },
  { n:'Simplilearn',  t:2, ind:'edtech',     c:'#FF6B00', s:'simplilearn'                    },
  // T3 — MNC India (Greenhouse)
  { n:'Visa',         t:3, ind:'bfsi',       c:'#1A1F71', s:'visa'                           },
  { n:'Mastercard',   t:3, ind:'bfsi',       c:'#EB001B', s:'mastercard'                     },
  { n:'PayPal',       t:3, ind:'fintech',    c:'#003087', s:'paypal'                         },
  { n:'Uber',         t:3, ind:'mobility',   c:'#000000', s:'uber'                           },
  { n:'Adobe',        t:3, ind:'saas',       c:'#FF0000', s:'adobe'                          },
  { n:'Salesforce',   t:3, ind:'saas',       c:'#00A1E0', s:'salesforce'                     },
  { n:'Cisco',        t:3, ind:'tech',       c:'#1BA0D7', s:'cisco'                          },
  { n:'IBM',          t:3, ind:'tech',       c:'#006699', s:'ibm'                            },
  { n:'Expedia',      t:3, ind:'travel',     c:'#00355F', s:'expedia'                        },
  { n:'Booking.com',  t:3, ind:'travel',     c:'#003580', s:'bookingcom'                     },
  { n:'GE',           t:3, ind:'industrial', c:'#00558A', s:'ge'                             },
  { n:'Honeywell',    t:3, ind:'industrial', c:'#FC4C02', s:'honeywell'                      },
  { n:'Siemens',      t:3, ind:'industrial', c:'#009999', s:'siemens'                        },
  { n:'Medtronic',    t:3, ind:'healthtech', c:'#004B87', s:'medtronic'                      },
  { n:'Deloitte',     t:3, ind:'consulting', c:'#86BC25', s:'deloitte'                       },
  { n:'Accenture',    t:3, ind:'services',   c:'#A100FF', s:'accenture'                      },
  { n:'Capgemini',    t:3, ind:'services',   c:'#0070AC', s:'capgemini'                      },
  { n:'ThoughtWorks', t:3, ind:'services',   c:'#FF6B35', s:'thoughtworks'                   },
  { n:'TCS',          t:3, ind:'services',   c:'#FF0000', s:'tcs'                            },
  { n:'Infosys',      t:3, ind:'services',   c:'#007CC3', s:'infosys'                        },
  { n:'Wipro',        t:3, ind:'services',   c:'#341C6D', s:'wipro'                          },
  { n:'HCL Tech',     t:3, ind:'services',   c:'#007AD0', s:'hcltech'                        },
  { n:'LTIMindtree',  t:3, ind:'services',   c:'#007DC3', s:'ltimindtree'                    },
  { n:'Persistent',   t:3, ind:'services',   c:'#E31837', s:'persistent'                     },
  { n:'EPAM',         t:3, ind:'services',   c:'#478A00', s:'epam'                           },
  { n:'ServiceNow',   t:3, ind:'saas',       c:'#81B5A1', s:'servicenow'                     },
  { n:'Cloudflare',   t:3, ind:'cloud',      c:'#F38020', s:'cloudflare'                     },
  { n:'Datadog',      t:3, ind:'cloud',      c:'#632CA6', s:'datadog'                        },
  { n:'Qualcomm',     t:3, ind:'tech',       c:'#3253DC', s:'qualcomm'                       },
  { n:'Intel',        t:3, ind:'tech',       c:'#0071C5', s:'intel'                          },
  { n:'Samsung',      t:3, ind:'tech',       c:'#1428A0', s:'samsung'                        },
  { n:'Netflix',      t:3, ind:'media',      c:'#E50914', s:'netflix'                        },
  // T4 — Global Product
  { n:'Stripe',       t:4, ind:'fintech',    c:'#635BFF', s:'stripe'                         },
  { n:'Anthropic',    t:4, ind:'ai',         c:'#D97706', s:'anthropic'                      },
  { n:'Figma',        t:4, ind:'saas',       c:'#F24E1E', s:'figma'                          },
  { n:'Coinbase',     t:4, ind:'crypto',     c:'#0052FF', s:'coinbase'                       },
  { n:'Airtable',     t:4, ind:'saas',       c:'#18BFFF', s:'airtable'                       },
  { n:'Asana',        t:4, ind:'saas',       c:'#F06A6A', s:'asana'                          },
  { n:'HubSpot',      t:4, ind:'saas',       c:'#FF7A59', s:'hubspot'                        },
  { n:'Amplitude',    t:4, ind:'saas',       c:'#8B5CF6', s:'amplitude'                      },
  { n:'Intercom',     t:4, ind:'saas',       c:'#1F8DED', s:'intercom'                       },
  { n:'Fivetran',     t:4, ind:'cloud',      c:'#60A5FA', s:'fivetran'                       },
  { n:'Twilio',       t:4, ind:'saas',       c:'#F22F46', s:'twilio'                         },
  { n:'Mixpanel',     t:4, ind:'saas',       c:'#7856FF', s:'mixpanel'                       },
  { n:'Braze',        t:4, ind:'saas',       c:'#FF5C5C', s:'braze'                          },
  { n:'Klaviyo',      t:4, ind:'saas',       c:'#F97316', s:'klaviyo'                        },
  { n:'Gong',         t:4, ind:'saas',       c:'#4CAF50', s:'gong'                           },
  { n:'Zendesk',      t:4, ind:'saas',       c:'#03363D', s:'zendesk'                        },
  { n:'Okta',         t:4, ind:'cloud',      c:'#007DC1', s:'okta'                           },
  { n:'Rippling',     t:4, ind:'hrtech',     c:'#FF5C5C', s:'rippling'                       },
  { n:'Snowflake',    t:4, ind:'cloud',      c:'#29B5E8', s:'snowflake'                      },
  { n:'Databricks',   t:4, ind:'cloud',      c:'#FF3621', s:'databricks'                     },
  { n:'MongoDB',      t:4, ind:'cloud',      c:'#47A248', s:'mongodb'                        },
  { n:'Confluent',    t:4, ind:'cloud',      c:'#1E88E5', s:'confluent'                      },
  { n:'CrowdStrike',  t:4, ind:'cloud',      c:'#E01E5A', s:'crowdstrike'                    },
  { n:'Palo Alto',    t:4, ind:'cloud',      c:'#FA582D', s:'paloaltonetworks'               },
  { n:'New Relic',    t:4, ind:'cloud',      c:'#1CE783', s:'newrelic'                       },
  { n:'Supabase',     t:4, ind:'cloud',      c:'#3ECF8E', s:'supabase'                       },
  { n:'dbt Labs',     t:4, ind:'cloud',      c:'#FF694A', s:'dbtlabs'                        },
  { n:'Reddit',       t:4, ind:'media',      c:'#FF4500', s:'reddit'                         },
  { n:'Pinterest',    t:4, ind:'media',      c:'#E60023', s:'pinterest'                      },
  { n:'Airbnb',       t:4, ind:'travel',     c:'#FF5A5F', s:'airbnb'                         },
  { n:'DoorDash',     t:4, ind:'food',       c:'#FF3008', s:'doordash'                       },
  { n:'Discord',      t:4, ind:'media',      c:'#5865F2', s:'discord'                        },
  { n:'Duolingo',     t:4, ind:'edtech',     c:'#58CC02', s:'duolingo'                       },
  { n:'Coursera',     t:4, ind:'edtech',     c:'#0056D2', s:'coursera'                       },
];

const LEVER = [
  { n:'Meesho',       t:1, ind:'ecommerce',  c:'#F43397', s:'meesho'       },
  { n:'CRED',         t:1, ind:'fintech',    c:'#6366f1', s:'cred'         },
  { n:'Paytm',        t:1, ind:'fintech',    c:'#002970', s:'paytm'        },
  { n:'BrowserStack', t:2, ind:'saas',       c:'#E55252', s:'browserstack' },
  { n:'Chargebee',    t:2, ind:'saas',       c:'#6366F1', s:'chargebee'    },
  { n:'CleverTap',    t:2, ind:'adtech',     c:'#FF6640', s:'clevertap'    },
  { n:'Postman',      t:2, ind:'saas',       c:'#FF6C37', s:'postman'      },
  { n:'Unacademy',    t:2, ind:'edtech',     c:'#08BD80', s:'unacademy'    },
  { n:'Scaler',       t:2, ind:'edtech',     c:'#7B1FA2', s:'scaler'       },
  { n:'Rapido',       t:2, ind:'mobility',   c:'#FBBF24', s:'rapido'       },
  { n:'HealthifyMe',  t:2, ind:'healthtech', c:'#10B981', s:'healthifyme'  },
  { n:'Mamaearth',    t:2, ind:'d2c',        c:'#FF8F00', s:'mamaearth'    },
  { n:'Canva',        t:4, ind:'saas',       c:'#7D2AE8', s:'canva'        },
  { n:'GitLab',       t:4, ind:'saas',       c:'#FC6D26', s:'gitlab'       },
  { n:'Shopify',      t:4, ind:'ecommerce',  c:'#96BF48', s:'shopify'      },
  { n:'Typeform',     t:4, ind:'saas',       c:'#261F5C', s:'typeform'     },
  { n:'Hotjar',       t:4, ind:'saas',       c:'#FF3C00', s:'hotjar'       },
  { n:'Veeva',        t:4, ind:'saas',       c:'#F26522', s:'veeva'        },
  { n:'Procore',      t:4, ind:'saas',       c:'#FF5722', s:'procore'      },
  { n:'Deliveroo',    t:4, ind:'food',       c:'#00CCBC', s:'deliveroo'    },
  { n:'Mattermost',   t:4, ind:'saas',       c:'#0072C6', s:'mattermost'   },
  { n:'Pristyn Care', t:2, ind:'healthtech', c:'#06B6D4', s:'pristyncare'  },
  { n:'Rapido',       t:2, ind:'mobility',   c:'#FBBF24', s:'rapido'       },
  { n:'Springworks',  t:2, ind:'hrtech',     c:'#7B1FA2', s:'springworks'  },
  { n:'Khatabook',    t:2, ind:'fintech',    c:'#3B82F6', s:'khatabook'    },
  { n:'Apna',         t:2, ind:'hrtech',     c:'#3B5BDB', s:'apna'         },
  { n:'Udaan',        t:1, ind:'b2b',        c:'#FF6633', s:'udaan'        },
  { n:'Ninjacart',    t:2, ind:'agritech',   c:'#FF6B00', s:'ninjacart'    },
  { n:'Rebel Foods',  t:2, ind:'food',       c:'#E63946', s:'rebelfoods'   },
  { n:'Lenskart',     t:2, ind:'ecommerce',  c:'#00BFFF', s:'lenskart'     },
  { n:'BlackBuck',    t:2, ind:'logistics',  c:'#1A1A2E', s:'blackbuck'    },
  { n:'Substack',     t:4, ind:'media',      c:'#FF6719', s:'substack'     },
  { n:'Quizlet',      t:4, ind:'edtech',     c:'#4257B2', s:'quizlet'      },
];

const ASHBY = [
  { n:'Razorpay',     t:1, ind:'fintech',    c:'#2666CF', s:'razorpay'     },
  { n:'Setu',         t:2, ind:'fintech',    c:'#0EA5E9', s:'setu'         },
  { n:'Jupiter',      t:2, ind:'fintech',    c:'#6366f1', s:'jupiter'      },
  { n:'Fi Money',     t:2, ind:'fintech',    c:'#5C5FFF', s:'fi'           },
  { n:'Navi',         t:2, ind:'fintech',    c:'#6C3EEB', s:'navi'         },
  { n:'BharatPe',     t:2, ind:'fintech',    c:'#22C55E', s:'bharatpe'     },
  { n:'Linear',       t:4, ind:'saas',       c:'#5E6AD2', s:'linear'       },
  { n:'Notion',       t:4, ind:'saas',       c:'#888888', s:'notion'       },
  { n:'Vercel',       t:4, ind:'cloud',      c:'#555555', s:'vercel'       },
  { n:'Ramp',         t:4, ind:'fintech',    c:'#FF5C5C', s:'ramp'         },
  { n:'Loom',         t:4, ind:'saas',       c:'#625DF5', s:'loom'         },
  { n:'Retool',       t:4, ind:'saas',       c:'#3B82F6', s:'retool'       },
  { n:'ElevenLabs',   t:4, ind:'ai',         c:'#000000', s:'elevenlabs'   },
  { n:'Mistral AI',   t:4, ind:'ai',         c:'#FF6B35', s:'mistral'      },
  { n:'Perplexity',   t:4, ind:'ai',         c:'#1FB8CD', s:'perplexity'   },
  { n:'Neon',         t:4, ind:'cloud',      c:'#00E599', s:'neon'         },
  { n:'Raycast',      t:4, ind:'saas',       c:'#FF6363', s:'raycast'      },
  { n:'Resend',       t:4, ind:'saas',       c:'#000000', s:'resend'       },
  { n:'Jar',          t:2, ind:'fintech',    c:'#F59E0B', s:'jar'          },
  { n:'Navi',         t:2, ind:'fintech',    c:'#6C3EEB', s:'navi'         },
  { n:'Khatabook',    t:2, ind:'fintech',    c:'#3B82F6', s:'khatabook'    },
  { n:'Campsite',     t:4, ind:'saas',       c:'#FF5C5C', s:'campsite'     },
  { n:'Runway',       t:4, ind:'ai',         c:'#000000', s:'runwayml'     },
  { n:'Anyscale',     t:4, ind:'ai',         c:'#00BFFF', s:'anyscale'     },
];

// Workable — paginated, 50/page
const WORKABLE = [
  { n:'Atlassian',    t:3, ind:'saas',       c:'#0052CC', s:'witatl'       },
  { n:'Freshworks',   t:1, ind:'saas',       c:'#2B99C5', s:'freshworks'   },
  { n:'Zoho',         t:1, ind:'saas',       c:'#E42527', s:'zoho'         },
  { n:'Springworks',  t:2, ind:'hrtech',     c:'#7B1FA2', s:'springworks'  },
  { n:'Exotel',       t:2, ind:'saas',       c:'#FF6B35', s:'exotel'       },
  { n:'Haptik',       t:2, ind:'ai',         c:'#00BCD4', s:'haptik'       },
];

// SmartRecruiters — paginated, country=IN filter built in
const SMARTRECRUITERS = [
  { n:'Freshworks',   t:1, ind:'saas',       c:'#2B99C5', s:'Freshworks'   },
  { n:'Visa India',   t:3, ind:'bfsi',       c:'#1A1F71', s:'Visa'         },
  { n:'Booking.com',  t:3, ind:'travel',     c:'#003580', s:'Booking'      },
  { n:'Zalando',      t:3, ind:'ecommerce',  c:'#FF6900', s:'Zalando'      },
];

// Eightfold — cursor paginated, location=India filter
const EIGHTFOLD = [
  { n:'American Express', t:3, ind:'bfsi',  c:'#0077C0', host:'aexp.eightfold.ai',    tenant:'aexp.com'          },
  { n:'Mastercard',       t:3, ind:'bfsi',  c:'#EB001B', host:'mastercard.eightfold.ai', tenant:'mastercard.com' },
  { n:'Wells Fargo',      t:3, ind:'bfsi',  c:'#D71E28', host:'wellsfargo.eightfold.ai', tenant:'wellsfargo.com' },
];

// Adzuna — MNC India queries (definitively Indian results)
const ADZUNA_MNCS = [
  { n:'JPMorgan',       c:'#003087', q:'JPMorgan Chase' },
  { n:'Goldman Sachs',  c:'#6699FF', q:'Goldman Sachs'  },
  { n:'Morgan Stanley', c:'#003087', q:'Morgan Stanley' },
  { n:'Microsoft',      c:'#00A4EF', q:'Microsoft'      },
  { n:'Google',         c:'#4285F4', q:'Google'         },
  { n:'Amazon',         c:'#FF9900', q:'Amazon'         },
  { n:'Deutsche Bank',  c:'#0018A8', q:'Deutsche Bank'  },
  { n:'Barclays',       c:'#00AEEF', q:'Barclays'       },
  { n:'HSBC',           c:'#DB0011', q:'HSBC'           },
  { n:'Citi',           c:'#003B70', q:'Citi'           },
  { n:'BNY Mellon',     c:'#1A1A2E', q:'BNY Mellon'     },
  { n:'Fidelity',       c:'#52B043', q:'Fidelity'       },
  { n:'S&P Global',     c:'#1A1A2E', q:'S&P Global'     },
  { n:'Northern Trust', c:'#1A1A2E', q:'Northern Trust' },
  { n:'State Street',   c:'#2E5A9C', q:'State Street'   },
  { n:'Oracle',         c:'#F80000', q:'Oracle India'   },
  { n:'SAP',            c:'#008FD3', q:'SAP'            },
  { n:'Workday',        c:'#005CB9', q:'Workday'        },
  { n:'United Airlines',c:'#005DAA', q:'United Airlines'},
  { n:'McKinsey',       c:'#003087', q:'McKinsey'       },
  { n:'BCG',            c:'#00664F', q:'BCG'            },
  { n:'Flipkart',       c:'#F74F00', q:'Flipkart'       },
  { n:'Walmart',        c:'#007DC6', q:'Walmart'        },
  { n:'Samsung India',  c:'#1428A0', q:'Samsung India'  },
  { n:'Ola',            c:'#FDD820', q:'Ola Cabs'       },
  { n:'MakeMyTrip',     c:'#E83151', q:'MakeMyTrip'     },
  { n:'Byju\'s',        c:'#00A0C6', q:'Byjus'          },
];

// Adzuna broad India city queries
const ADZUNA_CITY_QUERIES = [
  { cat:'it-jobs',                where:'bangalore' },
  { cat:'it-jobs',                where:'mumbai'    },
  { cat:'it-jobs',                where:'delhi'     },
  { cat:'it-jobs',                where:'hyderabad' },
  { cat:'it-jobs',                where:'pune'      },
  { cat:'engineering-jobs',       where:'bangalore' },
  { cat:'engineering-jobs',       where:'mumbai'    },
  { cat:'engineering-jobs',       where:'delhi'     },
  { cat:'engineering-jobs',       where:'hyderabad' },
  { cat:'engineering-jobs',       where:'pune'      },
  { cat:'accounting-finance-jobs',where:'bangalore' },
  { cat:'accounting-finance-jobs',where:'mumbai'    },
  { cat:'accounting-finance-jobs',where:'delhi'     },
  { cat:'sales-jobs',             where:'bangalore' },
  { cat:'sales-jobs',             where:'mumbai'    },
  { cat:'marketing-jobs',         where:'bangalore' },
  { cat:'marketing-jobs',         where:'mumbai'    },
  { cat:'hr-jobs',                where:'bangalore' },
  { cat:'graduate-jobs',          where:'bangalore' },
  { cat:'graduate-jobs',          where:'mumbai'    },
];

// ── INDIA CLASSIFICATION ──────────────────────────────────────────────────────

const INDIA_CITIES = [
  'bengaluru','bangalore','mumbai','bombay','delhi','new delhi','gurugram',
  'gurgaon','noida','hyderabad','secunderabad','pune','pimpri','chennai',
  'madras','kolkata','calcutta','ahmedabad','jaipur','surat','lucknow',
  'kochi','cochin','chandigarh','nagpur','bhubaneswar','indore','coimbatore',
  'vadodara','thiruvananthapuram','mysuru','mysore','visakhapatnam',
];

const INDIA_STATES = [
  'karnataka','maharashtra','telangana','andhra pradesh','tamil nadu',
  'gujarat','rajasthan','uttar pradesh','west bengal','kerala','haryana',
  'punjab','madhya pradesh','odisha','jharkhand','bihar','assam',
];

const NON_INDIA = [
  'united states','usa','u.s.a','new york','san francisco','los angeles',
  'seattle','austin','boston','chicago','denver','atlanta','miami',
  'washington dc','new jersey','california','texas','florida','illinois',
  'london','uk','united kingdom','england','germany','berlin','munich',
  'france','paris','netherlands','amsterdam','sweden','stockholm',
  'canada','toronto','vancouver','montreal','australia','sydney','melbourne',
  'singapore','dubai','uae','japan','tokyo','china','beijing','shanghai',
  'ireland','dublin','spain','madrid','poland','warsaw','czech republic',
  'hungary','romania','ukraine','israel','tel aviv','brazil','mexico',
];

function classifyIndia(location, tier, src) {
  // L5 — trusted sources always India
  if (['smartrecruiters','eightfold','adzuna'].includes(src)) return 'india';

  const loc = (location || '').toLowerCase().trim();

  // L1 — explicit India signal
  if (loc.includes('india') || loc === 'in') return 'india';
  if (INDIA_CITIES.some(c => loc.includes(c))) return 'india';
  if (INDIA_STATES.some(s => loc.includes(s))) return 'india';

  // L2 — explicit non-India signal
  if (NON_INDIA.some(c => loc.includes(c))) return 'skip';

  // L3/L4 — blank, remote, global, worldwide
  if (!loc || loc === 'remote' || loc === 'global' || loc === 'worldwide' || loc === 'anywhere') {
    return (tier === 1 || tier === 2) ? 'india' : 'skip';
  }

  // L4 — anything else from T3/T4
  if (tier === 3 || tier === 4) return 'skip';

  // Default keep for T1/T2
  return 'india';
}

function detectCity(loc) {
  const l = (loc || '').toLowerCase();
  if (l.includes('bengaluru') || l.includes('bangalore')) return 'Bengaluru';
  if (l.includes('mumbai') || l.includes('bombay'))       return 'Mumbai';
  if (l.includes('delhi') || l.includes('gurugram') || l.includes('gurgaon') || l.includes('noida')) return 'Delhi NCR';
  if (l.includes('hyderabad') || l.includes('secunderabad')) return 'Hyderabad';
  if (l.includes('pune') || l.includes('pimpri'))         return 'Pune';
  if (l.includes('chennai') || l.includes('madras'))      return 'Chennai';
  if (l.includes('kolkata') || l.includes('calcutta'))    return 'Kolkata';
  if (l.includes('ahmedabad'))                            return 'Ahmedabad';
  if (l.includes('remote'))                               return 'Remote';
  return 'India';
}

function detectMode(loc) {
  const l = (loc || '').toLowerCase();
  if (l.includes('remote')) return 'remote';
  if (l.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function detectSeniority(title) {
  const t = (title || '').toLowerCase();
  if (/\b(vp|vice president|director|head of|chief)\b/.test(t)) return 'director';
  if (/\b(staff|principal|distinguished)\b/.test(t))             return 'staff';
  if (/\b(senior|sr\.|lead)\b/.test(t))                          return 'senior';
  if (/\b(junior|jr\.|intern|graduate|fresher|trainee|entry)\b/.test(t)) return 'junior';
  return 'mid';
}

const SEARCH_SYNONYMS = {
  'pm':  'product manager', 'apm': 'associate product manager',
  'spm': 'senior product manager', 'sde': 'software engineer',
  'swe': 'software engineer', 'mle': 'machine learning engineer',
  'sre': 'site reliability engineer', 'de': 'data engineer',
  'ds':  'data scientist', 'da': 'data analyst',
  'em':  'engineering manager', 'tpm': 'technical program manager',
};

function detectFn(title) {
  const t = (title || '').toLowerCase();
  // expand synonyms first
  let expanded = t;
  for (const [k, v] of Object.entries(SEARCH_SYNONYMS)) {
    expanded = expanded.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  }
  if (/\b(software engineer|developer|sre|devops|backend|frontend|ios|android|machine learning|data engineer|infrastructure|platform|site reliability)\b/.test(expanded)) return 'engineering';
  if (/\b(product manager|product lead|product owner)\b/.test(expanded)) return 'product';
  if (/\b(designer|ux|ui |visual design|product design)\b/.test(expanded)) return 'design';
  if (/\b(data scientist|data analyst|analytics|business intelligence|quantitative)\b/.test(expanded)) return 'data';
  if (/\b(business analyst|business manager|strategy|chief of staff|program manager|consultant)\b/.test(expanded)) return 'bizops';
  if (/\b(marketing|growth|seo|content|performance marketing|demand gen)\b/.test(expanded)) return 'marketing';
  if (/\b(sales|account executive|sdr|bdr|business development|revenue)\b/.test(expanded)) return 'sales';
  if (/\b(recruiter|hr |people ops|talent acquisition|human resource)\b/.test(expanded)) return 'people';
  if (/\b(security|infosec|appsec|devsecops)\b/.test(expanded)) return 'security';
  if (/\b(finance|accounting|financial analyst|controller|fp&a)\b/.test(expanded)) return 'finance';
  if (/\b(customer success|support|csm |cx )\b/.test(expanded)) return 'cx';
  return 'other';
}

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'JobScout/6.0 (github.com/Gketan97/jobscout-date)', ...options.headers },
        signal: AbortSignal.timeout(12000),
        ...options,
      });
      if (r.status === 429) {
        console.log(`  Rate limited on ${url}, waiting ${2 ** i * 2}s...`);
        await sleep(2 ** i * 2000);
        continue;
      }
      if (!r.ok) {
        console.log(`  HTTP ${r.status} on ${url}`);
        return null;
      }
      return await r.json();
    } catch (e) {
      console.log(`  Fetch error (attempt ${i+1}): ${e.message}`);
      if (i < retries - 1) await sleep(2 ** i * 1000);
    }
  }
  return null;
}

// ── FETCHERS ──────────────────────────────────────────────────────────────────

function makeJob(fields) {
  return {
    id:        fields.id,
    title:     (fields.title || '').trim(),
    company:   (fields.company || '').trim(),
    location:  (fields.location || '').trim(),
    city:      fields.city || detectCity(fields.location || ''),
    mode:      fields.mode || detectMode(fields.location || ''),
    country:   'India',
    fn:        fields.fn || detectFn(fields.title || ''),
    tier:      fields.tier || 2,
    seniority: fields.seniority || detectSeniority(fields.title || ''),
    dept:      (fields.dept || '').trim(),
    url:       fields.url || '',
    color:     fields.color || '#6366f1',
    posted_at: fields.posted_at || '',
    src:       fields.src || 'other',
  };
}

// Greenhouse — single call per company, no pagination needed
async function fetchGreenhouse(co) {
  console.log(`  GH: ${co.n}`);
  const d = await fetchJSON(`https://boards-api.greenhouse.io/v1/boards/${co.s}/jobs?content=false`);
  if (!d) return [];
  const jobs = [];
  for (const j of (d.jobs || [])) {
    const loc = j.location?.name || '';
    if (classifyIndia(loc, co.t, 'greenhouse') === 'skip') continue;
    jobs.push(makeJob({
      id:        `gh-${j.id}`,
      title:     j.title,
      company:   co.n,
      location:  loc,
      dept:      j.departments?.[0]?.name || '',
      url:       `https://boards.greenhouse.io/${co.s}/jobs/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.updated_at ? j.updated_at.slice(0, 10) : '',
      src:       'greenhouse',
    }));
  }
  await sleep(150);
  return jobs;
}

// Lever — single call per company
async function fetchLever(co) {
  console.log(`  LV: ${co.n}`);
  const d = await fetchJSON(`https://api.lever.co/v0/postings/${co.s}?mode=json`);
  if (!d || !Array.isArray(d)) return [];
  const jobs = [];
  for (const j of d) {
    const loc = j.categories?.location || j.workplaceType || '';
    if (classifyIndia(loc, co.t, 'lever') === 'skip') continue;
    jobs.push(makeJob({
      id:        `lv-${j.id}`,
      title:     j.text,
      company:   co.n,
      location:  loc,
      dept:      j.categories?.department || '',
      url:       j.hostedUrl || `https://jobs.lever.co/${co.s}/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : '',
      src:       'lever',
    }));
  }
  await sleep(150);
  return jobs;
}

// Ashby — single call
async function fetchAshby(co) {
  console.log(`  AB: ${co.n}`);
  const d = await fetchJSON(`https://api.ashbyhq.com/posting-api/job-board/${co.s}`);
  if (!d) return [];
  const jobs = [];
  for (const j of (d.jobPostings || [])) {
    const loc = j.locationName || '';
    if (classifyIndia(loc, co.t, 'ashby') === 'skip') continue;
    jobs.push(makeJob({
      id:        `ab-${j.id}`,
      title:     j.title,
      company:   co.n,
      location:  loc,
      dept:      j.departmentName || '',
      url:       j.jobUrl || `https://jobs.ashbyhq.com/${co.s}/${j.id}`,
      color:     co.c,
      tier:      co.t,
      posted_at: j.publishedDate ? j.publishedDate.slice(0, 10) : '',
      src:       'ashby',
    }));
  }
  await sleep(150);
  return jobs;
}

// Workable — paginated, offset-based, 50 per page
async function fetchWorkable(co) {
  console.log(`  WK: ${co.n}`);
  const jobs = [];
  let offset = 0;
  while (true) {
    const d = await fetchJSON(
      `https://apply.workable.com/api/v3/accounts/${co.s}/jobs?limit=50&offset=${offset}`
    );
    if (!d?.results?.length) break;
    for (const j of d.results) {
      const loc = j.location?.city ? `${j.location.city}, ${j.location.country || ''}` : '';
      if (classifyIndia(loc, co.t, 'workable') === 'skip') continue;
      jobs.push(makeJob({
        id:        `wk-${j.shortcode || j.id}`,
        title:     j.title,
        company:   co.n,
        location:  loc,
        dept:      j.department || '',
        url:       `https://apply.workable.com/${co.s}/j/${j.shortcode || j.id}`,
        color:     co.c,
        tier:      co.t,
        posted_at: j.published_on ? j.published_on.slice(0, 10) : '',
        src:       'workable',
      }));
    }
    if (!d.next) break;
    offset += 50;
    await sleep(500);
  }
  return jobs;
}

// SmartRecruiters — paginated offset, country=IN built in
async function fetchSmartRecruiters(co) {
  console.log(`  SR: ${co.n}`);
  const jobs = [];
  let offset = 0;
  while (true) {
    const d = await fetchJSON(
      `https://api.smartrecruiters.com/v1/companies/${co.s}/postings?country=IN&limit=100&offset=${offset}&status=PUBLISHED`
    );
    if (!d?.content?.length) break;
    for (const j of d.content) {
      const city = j.location?.city || '';
      const country = j.location?.country || 'India';
      jobs.push(makeJob({
        id:        `sr-${j.id}`,
        title:     j.name,
        company:   co.n,
        location:  city ? `${city}, India` : 'India',
        dept:      j.department?.label || '',
        url:       j.ref || '',
        color:     co.c,
        tier:      co.t,
        posted_at: j.releasedDate ? j.releasedDate.slice(0, 10) : '',
        src:       'smartrecruiters',
      }));
    }
    const total = d.totalFound || 0;
    offset += 100;
    if (offset >= total) break;
    await sleep(500);
  }
  return jobs;
}

// Eightfold — cursor paginated, location=India
async function fetchEightfold(co) {
  console.log(`  EF: ${co.n}`);
  const jobs = [];
  let cursor = null;
  let page = 0;
  while (true) {
    const url = `https://${co.host}/api/apply/v2/jobs?domain=${co.tenant}&location=India&count=10${cursor ? `&cursor=${cursor}` : ''}`;
    const d = await fetchJSON(url);
    if (!d?.positions?.length) break;
    for (const j of d.positions) {
      jobs.push(makeJob({
        id:        `ef-${j.id}`,
        title:     j.name,
        company:   co.n,
        location:  j.location || 'India',
        dept:      j.department || '',
        url:       `https://${co.host}/careers?query=${encodeURIComponent(j.name)}&location=India`,
        color:     co.c,
        tier:      co.t,
        posted_at: j.updated_at ? j.updated_at.slice(0, 10) : '',
        src:       'eightfold',
      }));
    }
    cursor = d.next_cursor;
    if (!cursor) break;
    page++;
    if (page > 50) break; // safety cap
    await sleep(500);
  }
  return jobs;
}

// Adzuna — MNC company-specific India queries
async function fetchAdzunaMNC(co) {
  console.log(`  AZ MNC: ${co.n}`);
  const jobs = [];
  const seen = new Set();
  // One page per company to stay within free tier quota
  const url = `https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=50&company=${encodeURIComponent(co.q)}&content-type=application/json`;
  const d = await fetchJSON(url);
  if (!d?.results) return [];
  for (const j of d.results) {
    const id = `az-mnc-${j.id || hashStr((co.n + j.title))}`;
    if (seen.has(id)) continue;
    seen.add(id);
    jobs.push(makeJob({
      id,
      title:     j.title || '',
      company:   co.n,
      location:  j.location?.display_name || 'India',
      dept:      j.category?.label || '',
      url:       j.redirect_url || '',
      color:     co.c,
      tier:      3,
      posted_at: j.created ? j.created.slice(0, 10) : '',
      src:       'adzuna',
    }));
  }
  await sleep(300);
  return jobs;
}

// Adzuna — broad India city + category queries
async function fetchAdzunaCity(query) {
  const { cat, where } = query;
  const jobs = [];
  const seen = new Set();
  // Paginate up to 3 pages per query
  for (let page = 1; page <= 3; page++) {
    const url = `https://api.adzuna.com/v1/api/jobs/in/search/${page}?app_id=${ADZUNA_ID}&app_key=${ADZUNA_KEY}&results_per_page=50&category=${cat}&where=${where}&content-type=application/json`;
    const d = await fetchJSON(url);
    if (!d?.results?.length) break;
    for (const j of d.results) {
      const id = `az-${j.id || hashStr(j.title + j.company?.display_name)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      jobs.push(makeJob({
        id,
        title:     j.title || '',
        company:   j.company?.display_name || '',
        location:  j.location?.display_name || where,
        dept:      j.category?.label || '',
        url:       j.redirect_url || '',
        color:     '#F97316',
        tier:      2,
        posted_at: j.created ? j.created.slice(0, 10) : '',
        src:       'adzuna',
      }));
    }
    const total = d.count || 0;
    if (page * 50 >= total) break;
    await sleep(300);
  }
  return jobs;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// ── DEDUP ─────────────────────────────────────────────────────────────────────

function dedup(jobs) {
  const seen = new Map();
  const out = [];
  for (const j of jobs) {
    if (!j.id || !j.title) continue;
    // Normalise key: company + title + city
    const key = `${j.company}|${j.title}|${j.city}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(key)) {
      // Keep freshest
      const idx = seen.get(key);
      if ((j.posted_at || '') > (out[idx].posted_at || '')) out[idx] = j;
    } else {
      seen.set(key, out.length);
      out.push(j);
    }
  }
  return out;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('JobScout Crawler starting...');
  const startTime = Date.now();
  const allJobs = [];

  // Greenhouse
  console.log('\n── Greenhouse ──');
  for (const co of GREENHOUSE) {
    const jobs = await fetchGreenhouse(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // Lever
  console.log('\n── Lever ──');
  for (const co of LEVER) {
    const jobs = await fetchLever(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // Ashby
  console.log('\n── Ashby ──');
  for (const co of ASHBY) {
    const jobs = await fetchAshby(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // Workable
  console.log('\n── Workable ──');
  for (const co of WORKABLE) {
    const jobs = await fetchWorkable(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // SmartRecruiters
  console.log('\n── SmartRecruiters ──');
  for (const co of SMARTRECRUITERS) {
    const jobs = await fetchSmartRecruiters(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // Eightfold
  console.log('\n── Eightfold ──');
  for (const co of EIGHTFOLD) {
    const jobs = await fetchEightfold(co);
    console.log(`     ${jobs.length} India jobs`);
    allJobs.push(...jobs);
  }

  // Adzuna MNC queries
  if (ADZUNA_ID) {
    console.log('\n── Adzuna MNC queries ──');
    for (const co of ADZUNA_MNCS) {
      const jobs = await fetchAdzunaMNC(co);
      console.log(`     ${jobs.length} jobs`);
      allJobs.push(...jobs);
    }

    // Adzuna city queries
    console.log('\n── Adzuna city queries ──');
    for (const q of ADZUNA_CITY_QUERIES) {
      const jobs = await fetchAdzunaCity(q);
      console.log(`  ${q.cat}/${q.where}: ${jobs.length} jobs`);
      allJobs.push(...jobs);
    }
  } else {
    console.log('\nSkipping Adzuna — no API key set');
  }

  // Dedup and filter stale (>30 days)
  console.log('\n── Deduplicating ──');
  const deduped = dedup(allJobs);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const fresh = deduped.filter(j => !j.posted_at || j.posted_at >= cutoffStr);

  // Source breakdown
  const sources = {};
  for (const j of fresh) {
    sources[j.src] = (sources[j.src] || 0) + 1;
  }

  const cities = {};
  for (const j of fresh) {
    cities[j.city] = (cities[j.city] || 0) + 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n── Results ──`);
  console.log(`Total jobs:    ${fresh.length}`);
  console.log(`Elapsed:       ${elapsed}s`);
  console.log(`Sources:`, sources);
  console.log(`Cities:`, cities);

  // Write output
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

  // Write jobs.json (minified to save space)
  fs.writeFileSync(
    path.join(dataDir, 'jobs.json'),
    JSON.stringify({ v: 6, count: fresh.length, updated_at: new Date().toISOString(), jobs: fresh })
  );

  // Write meta.json (small file — quick health check for frontend)
  fs.writeFileSync(
    path.join(dataDir, 'meta.json'),
    JSON.stringify({ v: 6, count: fresh.length, updated_at: new Date().toISOString(), sources, cities, elapsed_s: parseFloat(elapsed) }, null, 2)
  );

  console.log('\nDone! Wrote data/jobs.json and data/meta.json');
}

main().catch(e => { console.error(e); process.exit(1); });
