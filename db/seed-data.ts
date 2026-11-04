// Curated starter dataset. Deliberately small and well-established — it exists to
// exercise the app until real data is scraped/imported. Not a clinical reference.

export type Severity = "minor" | "moderate" | "major" | "contraindicated";

// `aliases` include FDA EPC class names so imported drugs land in these classes.
export const classes: { slug: string; name: string; aliases?: string[] }[] = [
  { slug: "nsaid", name: "NSAIDs", aliases: ["NSAID", "Nonsteroidal anti-inflammatory drugs", "Non-steroidal anti-inflammatory drugs", "Nonsteroidal Anti-inflammatory Drug"] },
  { slug: "ssri", name: "Serotonin reuptake inhibitors (incl. SSRIs)", aliases: ["SSRIs", "SSRI", "Selective serotonin reuptake inhibitors", "Serotonin Reuptake Inhibitor"] },
  { slug: "maoi", name: "MAO inhibitors", aliases: ["MAOIs", "Monoamine oxidase inhibitors", "Monoamine Oxidase Inhibitor"] },
  { slug: "ace-inhibitor", name: "ACE inhibitors", aliases: ["Angiotensin converting enzyme inhibitors", "Angiotensin-converting enzyme inhibitors", "Angiotensin Converting Enzyme Inhibitor"] },
  { slug: "opioid", name: "Opioids", aliases: ["Opioid analgesics", "Opioid agonists", "Opioid Agonist", "Partial Opioid Agonist"] },
  { slug: "benzodiazepine", name: "Benzodiazepines", aliases: ["Benzodiazepine"] },
  { slug: "nitrate", name: "Nitrates", aliases: ["Organic nitrates", "Nitrate Vasodilator", "Nitric oxide donors"] },
  { slug: "pde5-inhibitor", name: "PDE5 inhibitors", aliases: ["Phosphodiesterase 5 inhibitors", "Phosphodiesterase-5 inhibitors", "Phosphodiesterase type 5 inhibitors", "PDE-5 inhibitors", "Phosphodiesterase 5 Inhibitor"] },
  { slug: "statin", name: "Statins", aliases: ["HMG-CoA reductase inhibitors", "HMG-CoA Reductase Inhibitor"] },
  { slug: "anticoagulant", name: "Anticoagulants", aliases: ["Oral anticoagulants", "Vitamin K Antagonist", "Factor Xa Inhibitor", "Direct Thrombin Inhibitor"] },
  { slug: "antiplatelet", name: "Antiplatelets", aliases: ["Antiplatelet agents", "Antiplatelet drugs", "Platelet aggregation inhibitors", "Platelet Aggregation Inhibitor", "P2Y12 Platelet Inhibitor"] },
  { slug: "ppi", name: "Proton pump inhibitors", aliases: ["PPIs", "Proton pump inhibitors", "Proton Pump Inhibitor"] },
  { slug: "fluoroquinolone", name: "Fluoroquinolones", aliases: ["Quinolones", "Quinolone antibiotics", "Fluoroquinolone Antibacterial", "Quinolone Antimicrobial"] },
  { slug: "macrolide", name: "Macrolide antibiotics", aliases: ["Macrolides", "Macrolide Antimicrobial", "Macrolide Antibacterial"] },
  { slug: "azole-antifungal", name: "Azole antifungals", aliases: ["Azoles", "Azole Antifungal"] },
  { slug: "beta-blocker", name: "Beta blockers", aliases: ["Beta-blockers", "Beta-adrenergic blockers", "Beta-adrenergic blocking agents", "beta-Adrenergic Blocker"] },
  { slug: "potassium-sparing-diuretic", name: "Potassium-sparing diuretics", aliases: ["Aldosterone antagonists", "Aldosterone Antagonist", "Potassium-sparing Diuretic", "Mineralocorticoid receptor antagonists"] },
];

export const drugs: {
  slug: string;
  name: string;
  kind?: "drug" | "supplement" | "food";
  classes?: string[];
  aliases?: string[];
}[] = [
  { slug: "ibuprofen", name: "Ibuprofen", classes: ["nsaid"], aliases: ["Advil", "Motrin", "Nurofen"] },
  { slug: "naproxen", name: "Naproxen", classes: ["nsaid"], aliases: ["Aleve", "Naprosyn"] },
  { slug: "diclofenac", name: "Diclofenac", classes: ["nsaid"], aliases: ["Voltaren", "Cataflam"] },
  { slug: "aspirin", name: "Aspirin", classes: ["nsaid", "antiplatelet"], aliases: ["Bayer", "Acetylsalicylic acid"] },
  { slug: "acetaminophen", name: "Acetaminophen", aliases: ["Tylenol", "Paracetamol", "Panadol"] },
  { slug: "warfarin", name: "Warfarin", classes: ["anticoagulant"], aliases: ["Coumadin", "Jantoven"] },
  { slug: "clopidogrel", name: "Clopidogrel", classes: ["antiplatelet"], aliases: ["Plavix"] },
  { slug: "sertraline", name: "Sertraline", classes: ["ssri"], aliases: ["Zoloft"] },
  { slug: "fluoxetine", name: "Fluoxetine", classes: ["ssri"], aliases: ["Prozac"] },
  { slug: "citalopram", name: "Citalopram", classes: ["ssri"], aliases: ["Celexa"] },
  { slug: "escitalopram", name: "Escitalopram", classes: ["ssri"], aliases: ["Lexapro", "Cipralex"] },
  { slug: "phenelzine", name: "Phenelzine", classes: ["maoi"], aliases: ["Nardil"] },
  { slug: "tramadol", name: "Tramadol", classes: ["opioid"], aliases: ["Ultram"] },
  { slug: "oxycodone", name: "Oxycodone", classes: ["opioid"], aliases: ["OxyContin", "Roxicodone"] },
  { slug: "codeine", name: "Codeine", classes: ["opioid"] },
  { slug: "alprazolam", name: "Alprazolam", classes: ["benzodiazepine"], aliases: ["Xanax"] },
  { slug: "diazepam", name: "Diazepam", classes: ["benzodiazepine"], aliases: ["Valium"] },
  { slug: "lorazepam", name: "Lorazepam", classes: ["benzodiazepine"], aliases: ["Ativan"] },
  { slug: "lisinopril", name: "Lisinopril", classes: ["ace-inhibitor"], aliases: ["Zestril", "Prinivil"] },
  { slug: "enalapril", name: "Enalapril", classes: ["ace-inhibitor"], aliases: ["Vasotec"] },
  { slug: "ramipril", name: "Ramipril", classes: ["ace-inhibitor"], aliases: ["Altace"] },
  { slug: "spironolactone", name: "Spironolactone", classes: ["potassium-sparing-diuretic"], aliases: ["Aldactone"] },
  { slug: "potassium-chloride", name: "Potassium chloride", kind: "supplement", aliases: ["K-Dur", "Klor-Con"] },
  { slug: "nitroglycerin", name: "Nitroglycerin", classes: ["nitrate"], aliases: ["Nitrostat"] },
  { slug: "isosorbide-mononitrate", name: "Isosorbide mononitrate", classes: ["nitrate"], aliases: ["Imdur"] },
  { slug: "sildenafil", name: "Sildenafil", classes: ["pde5-inhibitor"], aliases: ["Viagra", "Revatio"] },
  { slug: "tadalafil", name: "Tadalafil", classes: ["pde5-inhibitor"], aliases: ["Cialis"] },
  { slug: "simvastatin", name: "Simvastatin", classes: ["statin"], aliases: ["Zocor"] },
  { slug: "atorvastatin", name: "Atorvastatin", classes: ["statin"], aliases: ["Lipitor"] },
  { slug: "clarithromycin", name: "Clarithromycin", classes: ["macrolide"], aliases: ["Biaxin"] },
  { slug: "omeprazole", name: "Omeprazole", classes: ["ppi"], aliases: ["Prilosec", "Losec"] },
  { slug: "esomeprazole", name: "Esomeprazole", classes: ["ppi"], aliases: ["Nexium"] },
  { slug: "ciprofloxacin", name: "Ciprofloxacin", classes: ["fluoroquinolone"], aliases: ["Cipro"] },
  { slug: "calcium-carbonate", name: "Calcium carbonate", kind: "supplement", aliases: ["Tums", "Caltrate"] },
  { slug: "levothyroxine", name: "Levothyroxine", aliases: ["Synthroid", "Euthyrox", "Levoxyl"] },
  { slug: "fluconazole", name: "Fluconazole", classes: ["azole-antifungal"], aliases: ["Diflucan"] },
  { slug: "methotrexate", name: "Methotrexate", aliases: ["Trexall", "Otrexup"] },
  { slug: "trimethoprim-sulfamethoxazole", name: "Trimethoprim/sulfamethoxazole", aliases: ["Bactrim", "Septra", "Co-trimoxazole"] },
  { slug: "lithium", name: "Lithium", aliases: ["Lithobid", "Lithium carbonate"] },
  { slug: "digoxin", name: "Digoxin", aliases: ["Lanoxin"] },
  { slug: "amiodarone", name: "Amiodarone", aliases: ["Cordarone", "Pacerone"] },
  { slug: "metoprolol", name: "Metoprolol", classes: ["beta-blocker"], aliases: ["Lopressor", "Toprol XL"] },
  { slug: "verapamil", name: "Verapamil", aliases: ["Calan", "Isoptin"] },
  { slug: "metformin", name: "Metformin", aliases: ["Glucophage"] },
  { slug: "amoxicillin", name: "Amoxicillin", aliases: ["Amoxil"] },
  { slug: "ethinyl-estradiol", name: "Combined oral contraceptive", aliases: ["Ethinyl estradiol", "The pill"] },
  { slug: "st-johns-wort", name: "St. John's Wort", kind: "supplement", aliases: ["Hypericum perforatum"] },
  { slug: "ginkgo-biloba", name: "Ginkgo biloba", kind: "supplement", aliases: ["Ginkgo"] },
  { slug: "ethanol", name: "Alcohol", kind: "food", aliases: ["Ethanol", "Alcoholic beverages", "Ethyl alcohol"] },
  { slug: "grapefruit-juice", name: "Grapefruit juice", kind: "food", aliases: ["Grapefruit"] },
];

// Subjects: a drug slug, or "class:<slug>".
export const interactions: {
  a: string;
  b: string;
  severity: Severity;
  summary: string;
  mechanism?: string;
  recommendation?: string;
}[] = [
  {
    a: "warfarin", b: "class:nsaid", severity: "major",
    summary: "Significantly increased risk of bleeding, including GI bleeding.",
    mechanism: "NSAIDs inhibit platelet function and can damage the GI mucosa, adding to warfarin's anticoagulant effect.",
    recommendation: "Avoid combination where possible; if needed, monitor INR and for signs of bleeding.",
  },
  {
    a: "warfarin", b: "acetaminophen", severity: "moderate",
    summary: "Regular use of acetaminophen may raise INR.",
    mechanism: "Possible interference with vitamin K–dependent clotting factor synthesis at sustained doses.",
    recommendation: "Occasional use is generally acceptable; monitor INR with regular use above ~2 g/day.",
  },
  {
    a: "warfarin", b: "class:azole-antifungal", severity: "major",
    summary: "Markedly increased warfarin effect and bleeding risk.",
    mechanism: "Azoles inhibit CYP2C9/CYP3A4, reducing warfarin metabolism.",
    recommendation: "Consider warfarin dose reduction and monitor INR closely.",
  },
  {
    a: "warfarin", b: "amiodarone", severity: "major",
    summary: "Increased warfarin effect and bleeding risk; onset may be delayed by weeks.",
    mechanism: "Amiodarone inhibits CYP2C9 and CYP3A4.",
    recommendation: "Warfarin dose usually needs reduction; monitor INR closely for several weeks.",
  },
  {
    a: "warfarin", b: "ginkgo-biloba", severity: "moderate",
    summary: "Possible increased bleeding risk.",
    mechanism: "Ginkgo may inhibit platelet aggregation.",
    recommendation: "Avoid or use with caution and monitor for bleeding.",
  },
  {
    a: "class:ssri", b: "tramadol", severity: "major",
    summary: "Risk of serotonin syndrome and lowered seizure threshold.",
    mechanism: "Both increase serotonergic activity; SSRIs that inhibit CYP2D6 may also alter tramadol metabolism.",
    recommendation: "Avoid if possible; otherwise monitor for agitation, tremor, hyperthermia, and seizures.",
  },
  {
    a: "class:ssri", b: "class:maoi", severity: "contraindicated",
    summary: "Risk of severe, potentially fatal serotonin syndrome.",
    mechanism: "MAO inhibition prevents serotonin breakdown while SSRIs block its reuptake.",
    recommendation: "Do not combine. Observe required washout periods when switching (often 2–5 weeks).",
  },
  {
    a: "class:ssri", b: "st-johns-wort", severity: "major",
    summary: "Risk of serotonin syndrome.",
    mechanism: "St. John's Wort has serotonergic activity.",
    recommendation: "Avoid combination.",
  },
  {
    a: "class:ssri", b: "class:nsaid", severity: "moderate",
    summary: "Increased risk of GI bleeding.",
    mechanism: "SSRIs deplete platelet serotonin, impairing aggregation; NSAIDs add mucosal injury and platelet inhibition.",
    recommendation: "Consider gastroprotection (e.g. a PPI) and watch for signs of bleeding.",
  },
  {
    a: "class:ssri", b: "warfarin", severity: "moderate",
    summary: "Increased bleeding risk.",
    mechanism: "Impaired platelet function; some SSRIs (e.g. fluoxetine) also inhibit warfarin metabolism.",
    recommendation: "Monitor INR and for bleeding when starting or changing SSRI dose.",
  },
  {
    a: "class:opioid", b: "class:benzodiazepine", severity: "major",
    summary: "Profound sedation, respiratory depression, coma, and death (FDA boxed warning).",
    mechanism: "Additive CNS and respiratory depression.",
    recommendation: "Avoid unless no alternatives; use lowest doses and shortest duration with monitoring.",
  },
  {
    a: "class:nitrate", b: "class:pde5-inhibitor", severity: "contraindicated",
    summary: "Severe, potentially life-threatening hypotension.",
    mechanism: "Both increase cGMP-mediated vasodilation.",
    recommendation: "Do not combine. Nitrates should not be given within 24–48 h of a PDE5 inhibitor.",
  },
  {
    a: "class:ace-inhibitor", b: "class:potassium-sparing-diuretic", severity: "major",
    summary: "Risk of hyperkalemia (high blood potassium).",
    mechanism: "Both reduce renal potassium excretion.",
    recommendation: "Monitor serum potassium and renal function closely.",
  },
  {
    a: "class:ace-inhibitor", b: "potassium-chloride", severity: "moderate",
    summary: "Risk of hyperkalemia.",
    mechanism: "ACE inhibitors reduce aldosterone, decreasing potassium excretion.",
    recommendation: "Monitor serum potassium.",
  },
  {
    a: "class:potassium-sparing-diuretic", b: "potassium-chloride", severity: "major",
    summary: "Risk of severe hyperkalemia.",
    mechanism: "Reduced potassium excretion plus added potassium intake.",
    recommendation: "Generally avoid; if used, monitor potassium closely.",
  },
  {
    a: "class:ace-inhibitor", b: "class:nsaid", severity: "moderate",
    summary: "Reduced blood-pressure lowering effect and risk of kidney injury.",
    mechanism: "NSAIDs inhibit renal prostaglandins needed for kidney perfusion and blood-pressure control.",
    recommendation: "Monitor blood pressure and renal function, especially in elderly or dehydrated patients.",
  },
  {
    a: "simvastatin", b: "clarithromycin", severity: "contraindicated",
    summary: "Greatly increased simvastatin levels — risk of myopathy and rhabdomyolysis.",
    mechanism: "Clarithromycin strongly inhibits CYP3A4.",
    recommendation: "Do not combine; pause simvastatin during the antibiotic course.",
  },
  {
    a: "atorvastatin", b: "clarithromycin", severity: "moderate",
    summary: "Increased atorvastatin levels and risk of myopathy.",
    mechanism: "CYP3A4 inhibition.",
    recommendation: "Limit atorvastatin dose (e.g. ≤20 mg) or pause during treatment.",
  },
  {
    a: "simvastatin", b: "grapefruit-juice", severity: "major",
    summary: "Increased simvastatin levels and risk of myopathy.",
    mechanism: "Grapefruit inhibits intestinal CYP3A4.",
    recommendation: "Avoid large amounts of grapefruit juice.",
  },
  {
    a: "simvastatin", b: "amiodarone", severity: "major",
    summary: "Increased risk of myopathy/rhabdomyolysis.",
    mechanism: "Amiodarone inhibits simvastatin metabolism.",
    recommendation: "Do not exceed simvastatin 20 mg/day with amiodarone.",
  },
  {
    a: "clopidogrel", b: "omeprazole", severity: "moderate",
    summary: "Reduced antiplatelet effect of clopidogrel.",
    mechanism: "Omeprazole inhibits CYP2C19, which converts clopidogrel to its active form.",
    recommendation: "Prefer a PPI with less CYP2C19 inhibition (e.g. pantoprazole).",
  },
  {
    a: "clopidogrel", b: "esomeprazole", severity: "moderate",
    summary: "Reduced antiplatelet effect of clopidogrel.",
    mechanism: "CYP2C19 inhibition reduces activation of clopidogrel.",
    recommendation: "Prefer a PPI with less CYP2C19 inhibition (e.g. pantoprazole).",
  },
  {
    a: "class:fluoroquinolone", b: "calcium-carbonate", severity: "moderate",
    summary: "Greatly reduced antibiotic absorption.",
    mechanism: "Calcium chelates fluoroquinolones in the gut.",
    recommendation: "Take the antibiotic at least 2 h before or 6 h after calcium.",
  },
  {
    a: "levothyroxine", b: "calcium-carbonate", severity: "moderate",
    summary: "Reduced levothyroxine absorption.",
    mechanism: "Calcium binds levothyroxine in the GI tract.",
    recommendation: "Separate doses by at least 4 hours.",
  },
  {
    a: "methotrexate", b: "trimethoprim-sulfamethoxazole", severity: "major",
    summary: "Risk of serious bone-marrow suppression.",
    mechanism: "Additive antifolate effects and reduced renal clearance of methotrexate.",
    recommendation: "Avoid combination.",
  },
  {
    a: "methotrexate", b: "class:nsaid", severity: "major",
    summary: "Increased methotrexate toxicity, especially at high doses.",
    mechanism: "NSAIDs reduce renal clearance of methotrexate.",
    recommendation: "Avoid with high-dose methotrexate; monitor closely with low-dose therapy.",
  },
  {
    a: "lithium", b: "class:nsaid", severity: "major",
    summary: "Increased lithium levels and toxicity risk.",
    mechanism: "NSAIDs reduce renal lithium clearance.",
    recommendation: "Avoid or monitor lithium levels closely.",
  },
  {
    a: "lithium", b: "class:ace-inhibitor", severity: "major",
    summary: "Increased lithium levels and toxicity risk.",
    mechanism: "ACE inhibitors reduce renal lithium clearance.",
    recommendation: "Monitor lithium levels closely when starting or adjusting.",
  },
  {
    a: "digoxin", b: "amiodarone", severity: "major",
    summary: "Increased digoxin levels — risk of toxicity.",
    mechanism: "Amiodarone inhibits P-glycoprotein and renal clearance of digoxin.",
    recommendation: "Reduce digoxin dose (often by ~50%) and monitor levels.",
  },
  {
    a: "digoxin", b: "verapamil", severity: "major",
    summary: "Increased digoxin levels and additive slowing of heart rate.",
    mechanism: "P-glycoprotein inhibition plus additive AV-node effects.",
    recommendation: "Reduce digoxin dose and monitor levels and heart rate.",
  },
  {
    a: "class:beta-blocker", b: "verapamil", severity: "major",
    summary: "Risk of severe bradycardia, heart block, and heart failure.",
    mechanism: "Additive negative effects on heart rate, AV conduction, and contractility.",
    recommendation: "Avoid or use only with close cardiac monitoring.",
  },
  {
    a: "ethinyl-estradiol", b: "st-johns-wort", severity: "major",
    summary: "Reduced contraceptive effectiveness; breakthrough bleeding and unintended pregnancy reported.",
    mechanism: "St. John's Wort induces CYP3A4, increasing estrogen/progestin metabolism.",
    recommendation: "Avoid or use a backup non-hormonal method.",
  },
  {
    a: "aspirin", b: "ibuprofen", severity: "moderate",
    summary: "Ibuprofen may blunt aspirin's heart-protective antiplatelet effect; increased GI risk.",
    mechanism: "Ibuprofen competes with low-dose aspirin for the COX-1 binding site on platelets.",
    recommendation: "Take ibuprofen at least 30 min after or 8 h before immediate-release aspirin.",
  },
];
