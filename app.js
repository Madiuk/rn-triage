// Relai — Triage and Tasking
// app.js — all application logic
// Version: refactor/2026-05-08


// Today's date injected at runtime so AI never uses stale year
const TODAY = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});

const BASE_PROMPT = `GLP-1 telehealth RN triage. Today: ${TODAY}. Output ONLY valid JSON.

{"non_clinical_flag":bool,"non_clinical_items":["..."],"routed_to":"string","internal_note":"string","clinical_routing_flag":bool,"clinical_routing_level":"severe|moderate|mild|none","clinical_routing_note":"string","clinical_category":"GI side effects|Weight plateau|No early weight loss|Food noise/cravings|Hair loss|Fatigue|Heartburn/reflux|Diarrhea|Injection/administration|Dosing question|Skin/site reaction|Medication storage|Urgent-escalate|General/multiple","urgency":"routine|same-day|urgent","follow_up_questions":["..."],"draft_response":"string","review_request":{"question":"string or null","context":"routing|severity|category|kb_gap|protocol|null","confidence":0.0}}

non_clinical_flag: true if ANY non-clinical content present (billing, payment, shipping, tracking, refund, account, subscription, cancellation, prescription transfer, or any administrative request).
non_clinical_items: list the NON-CLINICAL CATEGORY for each non-clinical topic — use short standard labels only, never describe the situation. Valid labels: "Billing/Payment" | "Shipment/Tracking" | "Account/Subscription" | "Refund Request" | "General Inquiry" | "Complaint/Concern". Example: ["Shipment/Tracking"]. Empty array if none.
routed_to: the specific support department this should go to. Choose the closest match: "Shipping & Fulfillment" | "Billing Team" | "Account Support" | "Pharmacy Team" | "General Support". Empty string if non_clinical_flag false.
internal_note: A task-assignment note to paste into Bask chat as an internal staff note when routing. Direct instruction to the incoming staff member — what non-clinical task needs to be completed. Do NOT include any clinical information, symptoms, or medication details. Do NOT speculate about clinical causes. End every note with exactly this sentence: "Clinical concerns have been addressed by the RN." Example: "Patient has not received their order after 10 days. Please check order status, locate tracking information, and follow up with the patient directly. Clinical concerns have been addressed by the RN." Empty if non_clinical_flag false.
clinical_routing_flag: true if any side effect present.
clinical_routing_level: per SIDE EFFECT SEVERITY rules. "none" if no side effects.
clinical_routing_note: empty string always (deprecated).
clinical_category: MUST be EXACTLY one of these values — copy it verbatim: "Injection/Dosing" | "Side Effects" | "Severe Side Effects" | "Medication Management" | "Stall/Lack of Results" | "General Inquiry". Pick the single best match. Use "Severe Side Effects" when symptoms are urgent or life-threatening. Use "Side Effects" for all other reported side effects. Use "Injection/Dosing" for any injection technique, dosing schedule, missed dose, or storage questions. Use "Medication Management" for titration, switching medications, or medication-related decisions. Use "Stall/Lack of Results" for plateau, no weight loss, food noise, or appetite questions. Do NOT combine values, do NOT invent new values.
urgency: per URGENCY RULES.
follow_up_questions: specific questions if info missing. Include dose question if dose not stated.
review_request: Populate ONLY when your confidence on a clinical decision is below 0.75. Write a specific question for the supervising RN that would help you improve future responses — e.g. "Patient asked about black licorice with tirzepatide, is this a clinical concern?" Set context to: routing, severity, category, kb_gap, or protocol. Set confidence to your actual 0.0-1.0 score. If confidence is high, set question and context to null and confidence to 1.0.

review_request: Only populate when confidence < 0.75 on a clinical decision. question must be specific and answerable by a clinical expert — not a patient question. context must be one of: routing, severity, category, kb_gap, protocol. confidence is your certainty score 0.0-1.0. Set to null when confident.
draft_response: ALWAYS populate. Warm RN voice, patient details, prose with line breaks, 120 words max. If non_clinical_flag true: include one brief sentence acknowledging the non-clinical item is being handled by the support team, then address the clinical portion. If follow_up_questions present: warm opening then weave questions into flowing prose. Otherwise: complete actionable advice.

Knowledge base sections follow. Apply them precisely.`;

const CLINICAL_CATS = [
  'Injection/Dosing','Side Effects','Severe Side Effects',
  'Medication Management','Stall/Lack of Results','General Inquiry'
];

const NON_CLINICAL_CATS = [
  '-- None --',
  'Billing/Payment','Shipment/Tracking','Account/Subscription',
  'Refund Request','General Inquiry','Complaint/Concern'
];

const TIMEFRAMES = [
  {v:'routine',l:'Routine',c:'routine'},
  {v:'24h',l:'Within 24h',c:'same-day'},
  {v:'24-72h',l:'24-72 Hours',c:'same-day'},
  {v:'same-day',l:'Same Day',c:'same-day'},
  {v:'urgent',l:'URGENT',c:'urgent'},
];

const DEFAULT_KB = {
  sideeffects:[
    {name:"Nausea -- causes and education",nurse_name:"System",text:"Nausea affects roughly 40-44% of patients on compounded semaglutide and up to 56% on compounded tirzepatide. It is the most common side effect and is caused by the medication slowing gastric emptying -- food stays in the stomach longer, triggering the nausea reflex. It is most common during the first 4-8 weeks and after each dose increase. It is dose-dependent and expected -- it does not mean the medication is not working.\n\nPATIENT EDUCATION:\nEat smaller meals -- palm-sized portions, not plate-sized. Eat slowly and put your fork down between bites. Avoid fatty, greasy, fried, spicy, or very acidic foods. Avoid eating within 2-3 hours of injecting. Eat cold or room-temperature foods if hot foods worsen symptoms. Drink fluids between meals, not during. Ginger tea, ginger chews, or ginger ale can help. Peppermint tea may also reduce nausea.\n\nOTC OPTIONS: Tums or Pepcid (famotidine 20mg) -- nausea from GLP medications is often related to reflux and delayed gastric emptying, and antacids help. Pepto-Bismol for general stomach upset. Vitamin B6 (25mg up to three times daily) has evidence for nausea reduction.\n\nIF NAUSEA IS SEVERE OR PERSISTENT: We can request ondansetron (Zofran) prescription -- ask for local pharmacy name, address, and phone number. Temporary dose reduction or slower titration should be considered if nausea is affecting quality of life or nutrition."},

    {name:"Vomiting -- assessment and management",nurse_name:"System",text:"Vomiting occurs in roughly 24% of patients on compounded semaglutide and up to 30% on compounded tirzepatide. Like nausea, it is most common during dose escalation and typically improves as the body adjusts.\n\nMILD (occasional, <24 hours, able to keep fluids down): Reassure. Advise clear liquids, bland diet (BRAT: bananas, rice, applesauce, toast), small sips of fluid. Pepto-Bismol or Tums. Rest and avoid triggers. Follow up in 24-48 hours.\n\nMODERATE (frequent vomiting, affecting intake, 1-2 days): Ask follow-up questions -- is patient able to keep any fluids down? Any signs of dehydration (dark urine, dizziness when standing, no urination)? Consider requesting Zofran. Advise Pedialyte or Gatorade for electrolytes. Dose reduction or held dose should be discussed with provider.\n\nSEVERE -- ESCALATE IMMEDIATELY: Vomiting lasting more than 3 consecutive days. Unable to keep any fluids down for 24+ hours. Signs of dehydration. Blood in vomit. Accompanied by severe abdominal pain radiating to back. These require same-day provider review or ER evaluation."},

    {name:"Diarrhea -- assessment and management",nurse_name:"System",text:"Diarrhea occurs in about 30% of patients, more commonly with compounded tirzepatide due to its dual GIP/GLP-1 action accelerating gut motility. Usually resolves within 4-8 weeks as the body adjusts.\n\nMILD (loose stools, <3 per day, brief duration): Bland BRAT diet. Reduce fatty and high-fiber foods temporarily. Imodium (loperamide) starting at lowest dose per label. Increase fluid intake. Pedialyte or Gatorade to replace electrolytes.\n\nMODERATE (3-5 loose stools per day, affecting daily life): Ask about duration, hydration status, and ability to function. Imodium and electrolyte replacement. If not improving within 48 hours, consider dose reduction discussion with provider.\n\nSEVERE -- ESCALATE: Diarrhea lasting more than 3 consecutive days. More than 5-6 episodes per day. Blood or mucus in stool. Signs of dehydration. Severe abdominal cramping. High fever. These require same-day evaluation -- diarrhea this severe can cause acute kidney injury through dehydration."},

    {name:"Constipation -- assessment and management",nurse_name:"System",text:"Constipation affects roughly 24% of patients on compounded semaglutide and up to 36% on compounded tirzepatide. The GLP-1 mechanism slows gut motility as part of how it works, and this can cause constipation especially in patients who are also eating less and drinking less. Tirzepatide causes more constipation than semaglutide due to GIP receptor effects.\n\nMILD TO MODERATE (infrequent stools, discomfort, <1 week): Increase water intake significantly -- 8-10 glasses daily. Increase dietary fiber -- vegetables, fruits, beans, whole grains, flaxseed. Gentle walking and movement helps. MiraLax (polyethylene glycol) is first-line OTC -- gentle and non-habit-forming. Colace (docusate sodium) softens stool. Metamucil or psyllium fiber supplement. Prune juice.\n\nAVOID: Stimulant laxatives (Ex-Lax, Dulcolax) as first-line -- these can cause dependency and cramping. They can be used short-term if others fail.\n\nSEVERE -- ESCALATE: No bowel movement for more than 7 consecutive days. Severe abdominal pain or bloating. Vomiting with constipation (possible obstruction). Hard distended abdomen. These require same-day medical evaluation."},

    {name:"Heartburn and GERD -- education and management",nurse_name:"System",text:"Heartburn and GERD are common with GLP-1 medications because delayed gastric emptying allows acid to reflux into the esophagus more easily. Patients eating too much or too quickly make this significantly worse.\n\nEDUCATION: Eat smaller, slower meals. Do not eat within 2-3 hours of lying down. Elevate the head of the bed. Avoid trigger foods -- coffee, alcohol, carbonated drinks, tomatoes, citrus, chocolate, mint (paradoxically), fatty foods, and spicy foods. Loose, comfortable clothing around the waist.\n\nOTC TREATMENT (step-up approach):\n1. Tums or Rolaids (calcium carbonate) -- for mild, infrequent symptoms\n2. Pepcid (famotidine 20mg twice daily) -- H2 blocker, very effective, can use before meals\n3. Prilosec (omeprazole 20mg daily) or Nexium (esomeprazole 20mg daily) -- proton pump inhibitor, most effective for persistent GERD, take 30-60 minutes before first meal\nPepto-Bismol can coat the esophagus and reduce discomfort.\n\nNOTE: PPIs like omeprazole are meant for short-term use to manage GI side effects during titration -- not as permanent therapy for medication-induced GERD."},

    {name:"Hair loss (telogen effluvium) -- education",nurse_name:"System",text:"Hair loss is a known side effect affecting roughly 20-30% of patients, typically beginning 2-4 months after starting medication or after significant weight loss. It is almost always telogen effluvium -- the hair growth cycle shifts due to caloric restriction and nutritional changes, not because the medication directly damages hair follicles. This is the same type of hair loss that occurs after any significant physical stress, surgery, illness, or pregnancy.\n\nKEY REASSURANCE: This is temporary. Hair follicles are not dead. The hair grows back during the next growth cycle, typically 3-6 months after the loss begins. Most patients see full recovery.\n\nMANAGEMENT:\n-- Protein: The single most important factor. Patients need minimum 0.7-1g protein per pound of goal body weight daily. Inadequate protein is the primary driver of hair loss in GLP-1 patients.\n-- Biotin (2500-5000mcg daily), zinc, iron, and B-complex vitamins support hair regrowth\n-- A comprehensive multivitamin is essential for all patients on GLP-1 medications\n-- Collagen peptide supplements may help\n-- Avoid crash dieting or excessive caloric restriction\n\nASK: How much protein are you getting daily? Are you taking a multivitamin? Have you had labs checked recently including iron and ferritin? Iron deficiency is a common hidden cause of hair loss."},

    {name:"Fatigue -- causes and management",nurse_name:"System",text:"Fatigue is common, especially in the first weeks of therapy and after dose increases. Causes include: caloric deficit (the body has less fuel), dehydration, electrolyte imbalance from reduced food and fluid intake, muscle loss from inadequate protein, and adaptation to altered metabolism.\n\nEDUCATION AND MANAGEMENT:\n-- CALORIES: Track intake on MyFitnessPal or LoseIt. If eating under 1000-1100 calories daily, the fatigue is from under-fueling. Slowly burning carbohydrates (oatmeal, brown rice, sweet potato, lentils) are better fuel than simple sugars\n-- HYDRATION: 60-100oz water daily minimum. Dehydration is underappreciated as a fatigue cause in GLP-1 patients because reduced appetite often reduces fluid intake too\n-- ELECTROLYTES: Add Gatorade Zero, Pedialyte, LMNT, or liquid IV. Especially important if patient is also exercising\n-- PROTEIN: Minimum 80-100g daily. Muscle loss causes fatigue. Prioritize protein at every meal\n-- SUPPLEMENTS: Multivitamin daily. B12 (sublingual or injection most bioavailable). Iron if ferritin is low\n-- EXERCISE: Paradoxically, light daily movement (20-minute walk) increases energy through endorphin release and improved circulation\n\nSEVERE OR UNUSUAL FATIGUE: If fatigue is debilitating, worsening, or accompanied by weakness, dizziness, shortness of breath, or palpitations -- this warrants labs and provider review. Rule out anemia, thyroid dysfunction, and low blood sugar."},

    {name:"Injection site reactions -- management",nurse_name:"System",text:"Injection site reactions occur in roughly 10-17% of patients and include redness, swelling, bruising, itching, or a small lump at the injection site. These are almost always local reactions and resolve on their own.\n\nMANAGEMENT OF MILD REACTIONS:\n-- Rotate injection sites every week. Recommended sites: abdomen (at least 2 inches from navel), outer thigh, or upper outer arm. Do not inject into the same location repeatedly\n-- Let the medication reach room temperature before injecting (5-10 minutes out of refrigerator)\n-- Clean the site with alcohol swab and let it fully dry before injecting\n-- Inject slowly -- pushing the plunger quickly increases local irritation\n-- Apply a cool compress or ice pack to the site after injecting to reduce swelling\n-- Avoid areas with scars, stretch marks, moles, or previous injection lumps\n-- Antihistamine cream (hydrocortisone 1%) for persistent itching at site\n\nSEVERE REACTIONS -- ESCALATE IMMEDIATELY:\n-- Rash that is spreading rapidly beyond the injection site\n-- Hives anywhere on the body\n-- Facial swelling, lip swelling, or tongue swelling\n-- Difficulty breathing or throat tightening\n-- These are signs of anaphylaxis -- call 911 immediately. Do not wait."},

    {name:"Hypoglycemia -- recognition and emergency response",nurse_name:"System",text:"Compounded semaglutide and tirzepatide do not typically cause hypoglycemia on their own in patients without diabetes, because they only stimulate insulin release when blood glucose is elevated. However, hypoglycemia CAN occur in patients who: are also taking insulin or sulfonylureas, have skipped meals for extended periods, have over-exercised without adequate carbohydrate intake, or are new to the medication with lower baseline blood sugar.\n\nSYMPTOMS to recognize:\nMild: shakiness, sweating, hunger, mild anxiety, rapid heartbeat, pale skin, mild confusion, dizziness, headache\nModerate: difficulty concentrating, irritability, unusual behavior, blurred vision, slurred speech\nSevere: loss of consciousness, seizure -- call 911 immediately\n\nIMMEDIATE TREATMENT (15-15 Rule):\n1. If conscious and able to swallow: Give 15 grams fast-acting carbohydrate immediately\n   -- 4oz (half a cup) regular fruit juice or regular soda (NOT diet)\n   -- 3-4 glucose tablets\n   -- 1 tablespoon of honey or sugar\n   -- A small handful of regular candy (gummy bears work well)\n2. Wait 15 minutes and recheck symptoms\n3. If symptoms persist, repeat the 15g carbohydrate\n4. Once feeling better, eat a small protein + carbohydrate snack (peanut butter and crackers, cheese and crackers) to stabilize\n\nIF PATIENT CANNOT SWALLOW or loses consciousness: Call 911. Do not give anything by mouth."},

    {name:"Gallbladder disease -- recognition",nurse_name:"System",text:"GLP-1 medications increase the risk of gallstones and gallbladder inflammation (cholecystitis). This occurs because the medication reduces appetite and meal frequency, which reduces gallbladder contractions -- bile then stagnates and can form stones. Rapid weight loss itself also increases gallstone risk independently.\n\nSYMPTOMS to recognize:\nGallstone attack (biliary colic): Sudden, intense pain in the right upper abdomen or center of abdomen, often after eating a fatty meal. May radiate to the right shoulder or upper back. Usually comes in waves and lasts 30 minutes to several hours. Nausea and vomiting often accompany it.\n\nCholecystitis (inflamed gallbladder): Pain is constant and more severe than biliary colic. Right upper quadrant tenderness. Fever and chills. Nausea and vomiting. Symptoms typically last longer than biliary colic.\n\nDISTINGUISH from regular GI side effects: Standard GLP-1 nausea is diffuse and not specifically localized to the right upper abdomen. Gallbladder pain is sharper, more localized, and often worse after fatty foods.\n\nACTION: Any patient with new right upper abdominal pain, especially after fatty meals, with fever, or with severe nausea and vomiting that feels different from their usual GI side effects -- needs same-day provider evaluation and likely ultrasound."},

    {name:"Pancreatitis -- red flags and emergency recognition",nurse_name:"System",text:"Acute pancreatitis is a rare but serious adverse event with GLP-1 therapy. The absolute risk is low, but because the consequences of missing it are severe, every RN must be able to recognize it immediately.\n\nCLASSIC PRESENTATION:\n-- Sudden onset severe pain in the upper abdomen (epigastric region), often described as boring through to the back\n-- Pain is persistent (not crampy or wave-like like gallbladder colic) and often worsens when lying flat, improves slightly when leaning forward\n-- Nausea and vomiting that do not resolve\n-- Fever and elevated heart rate\n-- Abdominal distension and tenderness\n-- Symptoms typically begin within hours to days after a dose increase (10 cases in 25% of reported AP cases involved dose escalation)\n\nDISTINGUISH from GI side effects: Regular GLP-1 nausea is milder, not associated with severe localized pain, and improves with dietary changes. Pancreatitis pain is severe, constant, and does not improve.\n\nRED FLAGS requiring immediate 911 or ER:\n-- Severe, constant upper abdominal pain radiating to the back\n-- High fever with abdominal pain\n-- Rapid heart rate with abdominal pain\n-- Complete inability to keep anything down with severe pain\n-- Patient sounds distressed, not just uncomfortable\n\nACTION: Stop medication immediately. Do not advise patient to wait. Send to ER. Document everything. Do not re-challenge with GLP-1 therapy without provider clearance."}
  ],
  templates:[
    {name:"Weight plateau -- follow-up questions",nurse_name:"System",text:"Do you mind answering a few questions for me so I can give you some customized advice?\n\n- Are you finding yourself having cravings during the day, and food noise returning by day 4-5 after injection?\n- How many calories are you eating per day? Are you tracking on an app like LoseIt or MyFitnessPal?\n- How much protein are you getting daily? We aim for at least 0.7g per pound of goal body weight\n- Are you drinking at minimum 60-80oz of water per day?\n- Are you getting enough fiber -- through vegetables, fruits, or a supplement?\n- What does your exercise routine look like?\n- Have your sleep and stress levels been consistent?\n\nQuick resource: I recommend https://tdee.is/ -- calculating your Total Daily Energy Expenditure helps determine the right calorie target. Most plateaus are either a calorie creep above TDEE or a metabolic adaptation that needs a small adjustment."},
    {name:"Food noise and cravings returning",nurse_name:"System",text:"It is completely normal -- and expected -- for food noise and hunger to return in the days before your next injection. The half-life of compounded semaglutide is approximately 7 days and compounded tirzepatide is approximately 5 days. By day 4-5 after injection, levels are naturally lower and appetite suppression decreases. This is pharmacokinetics, not a sign the medication has stopped working.\n\nFor managing hunger between injections:\n-- Protein at every meal significantly extends satiety. Aim for 25-35g protein per meal\n-- High-fiber foods (vegetables, legumes, oats) slow digestion and prolong fullness\n-- Drink 8-10oz of water or sparkling water when hunger strikes -- thirst is often mistaken for hunger\n-- Track calories on LoseIt or MyFitnessPal to stay aware of intake\n-- Use https://tdee.is/ to know your maintenance calorie level -- stay 300-500 below it, not drastically lower\n-- Small frequent snacks rather than large meals\n-- I recommend weighing once weekly, same day, same time, same scale. Daily weigh-ins create unnecessary anxiety due to normal water fluctuations."},
    {name:"No early weight loss -- patient education",nurse_name:"System",text:"Not seeing weight loss in the first 2-4 weeks is common and does not mean the medication is not working. Here is what is happening during this phase:\n\nThe medication is working first on blood sugar regulation, appetite signaling, and metabolic adaptation before the body begins releasing stored fat. This adjustment phase is normal. Additionally, if you are exercising, you may be building muscle while losing fat -- the scale may not move but body composition is changing.\n\nThings to review:\n-- Are you tracking calories? Even on GLP-1 therapy, a caloric deficit is required for weight loss. Use https://tdee.is/ to calculate your TDEE and aim for 300-500 calories below it\n-- Are you eating enough protein? Low protein causes muscle loss, which slows metabolism\n-- Are you drinking enough water? Retention of water can mask fat loss on the scale\n-- Are you constipated? This can add 2-5 pounds of scale weight\n\nTypical timeline: Most patients see meaningful weight loss by weeks 4-8. The medication continues working for 12-16+ weeks. Patience and consistency matter more than speed."}
  ],
  protocols:[
    {name:"PROTOCOL -- Nausea triage decision tree",nurse_name:"System",text:"Use this protocol when a patient reports nausea.\n\nSTEP 1: Assess severity\nASK: Is nausea accompanied by vomiting? How many days has it been occurring? Can you eat and drink? Is there any abdominal pain?\n\nIF severe abdominal pain present --> See pancreatitis and gallbladder protocols. Do not treat as routine nausea.\n\nSTEP 2: Classify\nMILD: Nausea only, no vomiting, able to eat small amounts, less than 2 weeks\n  --> RESPONSE: Education on meal size/speed/timing. OTC options (Tums, Pepcid, B6). Dietary adjustments. Reassurance. Monitor.\n\nMODERATE: Nausea with occasional vomiting, affecting meal intake, 2-4 weeks\n  --> RESPONSE: Above education + Zofran prescription request (ask for pharmacy details). Ask about dose timing relative to meals. Assess whether dose increase was recent -- if so, consider holding current dose for additional 4 weeks before next escalation. Hydration and electrolytes.\n\nSEVERE: Persistent vomiting more than 3 days, unable to keep fluids down, dehydration signs\n  --> ACTION: Same-day provider escalation. Do not manage with education alone. Patient may need IV fluids."},

    {name:"PROTOCOL -- Dose escalation decisions",nurse_name:"System",text:"Use this protocol when patient asks about increasing dose or when managing side effects that may require dose adjustment.\n\nRULE 1 -- Standard titration schedule:\nCompounded semaglutide: 0.25mg x 4 weeks, then 0.5mg x 4 weeks, then 1mg x 4 weeks, then 1.7mg x 4 weeks, then 2.4mg maintenance. Each step is 4 weeks minimum.\nCompounded tirzepatide: 2.5mg x 4 weeks, then 5mg x 4 weeks, then 7.5mg x 4 weeks, then 10mg x 4 weeks, then 12.5mg x 4 weeks, then 15mg maintenance.\n\nRULE 2 -- Do NOT increase dose if:\n-- Patient is experiencing moderate to severe GI side effects at current dose\n-- Patient has had vomiting in the past 2 weeks\n-- Patient has been on current dose less than 4 weeks\n-- Patient is experiencing significant fatigue or dehydration\n\nRULE 3 -- Consider dose reduction (back to previous dose) if:\n-- Current dose causing vomiting more than twice per week\n-- Unable to maintain adequate nutrition or hydration\n-- Quality of life significantly affected\n\nRULE 4 -- Slow titration option:\nFor sensitive patients: Hold each dose for 6-8 weeks instead of 4 before escalating. This is clinically appropriate and reduces dropout.\n\nRULE 5 -- Missed injection:\nIf missed by less than 4 days: Inject as soon as remembered, then resume normal weekly schedule.\nIf missed by 4 days or more: Skip the missed dose, inject at the next scheduled time.\nDo NOT double dose to make up for a missed injection."},

    {name:"PROTOCOL -- Injection and storage error response",nurse_name:"System",text:"Use this protocol when patient reports an issue with injection technique or medication storage.\n\nSTORAGE ERRORS:\nCompounded semaglutide and tirzepatide must be refrigerated at 36-46 degrees F (2-8 degrees C). Do not freeze. Keep away from direct light.\n\nIF LEFT AT ROOM TEMPERATURE:\n-- Less than 24 hours: Generally acceptable for a single dose. Do not use if medication appears cloudy, discolored, or has particles.\n-- 24-48 hours: Use with caution. Potency may be reduced. Consult pharmacy if concerned.\n-- More than 48 hours: Discard. Do not use. Contact provider for replacement.\n\nIF FROZEN: Discard immediately. Freezing damages the peptide structure. Do not thaw and use.\n\nINJECTION TECHNIQUE REVIEW:\n-- Use U-100 insulin syringe for compounded vials\n-- Wipe vial top with alcohol swab before each draw\n-- Draw air into syringe equal to dose volume before inserting needle\n-- Insert needle at 45-90 degree angle into subcutaneous fat (pinch skin if thin)\n-- Inject slowly, 10-15 seconds for full injection\n-- Do not rub the site after injecting\n-- Rotate sites: abdomen, thigh, upper arm -- never inject same spot twice in a row\n\nDOSE CALCULATION REMINDER:\nFormula: Units to draw = (dose in mg / concentration in mg per mL) x 100\nExample: 0.5mg dose from a 2mg/mL vial = (0.5 / 2) x 100 = 25 units\nAlways confirm concentration with pharmacy if unsure."},

    {name:"PROTOCOL -- Hypoglycemia response decision tree",nurse_name:"System",text:"Use this protocol when patient reports shakiness, sweating, confusion, dizziness, or other hypoglycemia symptoms.\n\nSTEP 1: Is patient currently symptomatic?\nIF YES (symptoms happening right now):\n  --> Instruct patient to eat 15g fast carbohydrate immediately (4oz juice, 3-4 glucose tablets, regular soda)\n  --> Stay on the line or call back in 15 minutes to confirm resolution\n  --> IF no improvement in 15 minutes: call 911\n  --> Document and escalate to provider\n\nIF NO (describing a past episode):\n  --> Assess when it occurred: before or after eating? After exercise? Mid-morning?\n  --> Assess what patient was eating and when\n  --> Assess whether patient takes other diabetes medications (insulin, sulfonylureas)\n\nSTEP 2: Classify risk\nLOW RISK (isolated episode, ate late, felt better after eating):\n  --> Educate on not skipping meals, importance of protein and carbohydrate balance\n  --> Advise keeping fast carbohydrate available\n  --> Monitor\n\nHIGH RISK (recurrent episodes, patient on insulin or sulfonylurea, severe symptoms, loss of consciousness):\n  --> Same-day provider escalation\n  --> Do not manage with education alone\n  --> Medication adjustment may be required"},

    {name:"PROTOCOL -- Allergic reaction and anaphylaxis",nurse_name:"System",text:"GLP-1 medications can rarely cause allergic reactions ranging from mild local reactions to life-threatening anaphylaxis.\n\nMILD LOCAL REACTION (redness, itching, small swelling at injection site only):\n  --> Rotate injection sites. Let medication reach room temperature before injecting. Ice after injection. OTC hydrocortisone cream 1% to site. Monitor.\n\nGENERALIZED ALLERGIC REACTION (hives, rash away from injection site, itching all over):\n  --> Stop medication. Take oral antihistamine (Benadryl 25-50mg). Notify provider. Do not re-inject until provider reviewed.\n\nANAPHYLAXIS -- CALL 911 IMMEDIATELY (do not wait):\nSigns: Throat tightening or difficulty swallowing, difficulty breathing or wheezing, rapid or weak pulse, dizziness or loss of consciousness, pale or bluish skin, sudden severe hives with any of the above symptoms\n  --> Call 911 now\n  --> If patient has epinephrine auto-injector (Epi-Pen): use it immediately in outer thigh\n  --> Stay with patient until emergency services arrive\n  --> Document and notify provider\n  --> Do not re-initiate GLP-1 therapy without allergy evaluation"}
  ],
  urls:[
    {name:"TDEE Calculator",nurse_name:"System",text:"https://tdee.is/ -- Total Daily Energy Expenditure calculator. Reference for all weight loss, plateau, and calorie discussions. Recommend to all patients asking about weight loss pace or plateau."},
    {name:"Calorie tracking -- LoseIt",nurse_name:"System",text:"https://loseit.com/ -- Recommended calorie and food tracking app. Free version is sufficient. Recommend alongside TDEE calculator for plateau management."},
    {name:"Calorie tracking -- MyFitnessPal",nurse_name:"System",text:"https://www.myfitnesspal.com/ -- Alternative calorie tracking app. Large food database. Patient preference between LoseIt and MyFitnessPal is fine."},
    {name:"Electrolyte supplement reference",nurse_name:"System",text:"Pedialyte, Gatorade Zero, LMNT, Liquid IV, or Nuun tablets are all appropriate electrolyte options for patients experiencing dehydration, fatigue, diarrhea, or heavy sweating. Recommend for any patient with GI symptoms or fatigue."}
  ],
  routing:[
    {name:"Non-clinical patient message",nurse_name:"System",text:"Thank you for reaching out -- I have flagged your question and am routing it to our support team who will follow up with you directly. I will address your clinical question separately below."},
    {name:"CLINICAL ROUTING RULES",nurse_name:"System",text:"These rules determine clinical_routing_flag, clinical_routing_level, and clinical_routing_note.\n\nSEVERE -- clinical_routing_level: severe. Requires immediate provider escalation. Do not wait for patient reply.\nTriggers: Vomiting lasting more than 3 consecutive days. Diarrhea lasting more than 3 consecutive days. Constipation more than 7 days with distension or pain. Severe upper abdominal pain (especially radiating to back -- pancreatitis). Any signs of anaphylaxis (throat tightening, difficulty breathing, spreading hives, facial swelling). Fever with abdominal pain. Severe back pain. Signs of hypoglycemia with altered consciousness or inability to self-treat. Any symptom the nurse assesses as potentially life-threatening. Inability to keep fluids down for more than 24 hours.\nclinical_routing_note format: ESCALATE TO PROVIDER -- Patient reporting [symptom]. Requires immediate provider review. Do not wait for patient reply before acting. Flag for physician or supervising clinician.\n\nMODERATE -- clinical_routing_level: moderate. Needs to be addressed but can wait for initial RN response and follow-up questions.\nTriggers: Moderate diarrhea or vomiting (frequent but not 3+ days, able to keep some fluids down). Moderate nausea significantly affecting eating. Abdominal pain that is uncomfortable but not severe. Injection site reaction that is spreading slightly. Fatigue affecting daily function. Symptoms improving but not resolved after 5+ days.\nclinical_routing_note format: FOLLOW-UP NEEDED -- Patient reports [symptom]. RN to gather more information in initial response. Based on patient reply, determine if provider escalation or patient education is appropriate.\n\nMILD -- clinical_routing_level: mild. Education-focused response appropriate. No provider escalation needed.\nTriggers: Mild nausea (not affecting intake). Mild constipation (less than 1 week). Heartburn or reflux. Hair loss. Mild fatigue. Mild injection site reactions (redness, minor swelling at site only).\nclinical_routing_note format: EDUCATION RESPONSE -- Patient reports [symptom]. RN to provide education and self-management guidance. Monitor for worsening and follow up as needed.\n\nNONE -- clinical_routing_level: none, clinical_routing_flag: false. No side effects present.\nApplies to: Weight plateau. No early weight loss. Food noise (hunger or cravings between injections -- this is NOT a side effect). Dosing questions without red flags. Food and nutrition questions. Non-clinical requests only. General check-in messages."}
  ],
  notes:[
    {name:"Dose verification and calculation",nurse_name:"System",text:"ALWAYS ask for dose in mg and units if not provided in any message involving side effects, dose changes, or injection questions.\n\nCompounded medications use U-100 insulin syringes. The formula to convert:\nUnits to draw = (Dose in mg / Concentration in mg per mL) x 100\n\nCommon compounded semaglutide concentrations: 1 mg/mL, 2 mg/mL, 2.5 mg/mL, 5 mg/mL\nCommon compounded tirzepatide concentrations: 10 mg/mL, 17 mg/mL, 20 mg/mL\n\nExample: Patient prescribed 0.5mg semaglutide from a 2mg/mL vial: (0.5/2) x 100 = 25 units\nExample: Patient prescribed 5mg tirzepatide from a 10mg/mL vial: (5/10) x 100 = 50 units\n\nNEVER assume concentration. If patient does not know, advise them to check the vial label or contact their pharmacy.\n\nVERIFY: Dose in mg matches their prescribed titration schedule. Flag if patient appears to be taking more than their prescribed dose."},

    {name:"Medication differences -- semaglutide vs tirzepatide",nurse_name:"System",text:"Understanding the clinical differences helps personalize responses.\n\nCOMPOUNDED SEMAGLUTIDE:\nMechanism: GLP-1 receptor agonist only\nHalf-life: approximately 7 days\nDosing range: 0.25mg (starting) to 2.4mg (max weekly)\nWeight loss: approximately 12-15% body weight average at therapeutic doses\nSide effect profile: Nausea is more prominent. Constipation less common than tirzepatide. Generally well tolerated with slow titration.\nOnset of appetite suppression: Typically within 1-2 weeks of first dose\n\nCOMPOUNDED TIRZEPATIDE:\nMechanism: Dual GIP and GLP-1 receptor agonist\nHalf-life: approximately 5 days (shorter -- this is why food noise returns faster near end of week)\nDosing range: 2.5mg (starting) to 15mg (max weekly)\nWeight loss: approximately 18-22% body weight average at therapeutic doses -- significantly more than semaglutide\nSide effect profile: More constipation due to GIP effects on gut motility. Nausea may be slightly less than semaglutide for some patients. More effective at suppressing appetite but this means GI side effects can be more pronounced if titration is rushed.\nOnset of appetite suppression: Often faster -- within days of first dose\n\nCLINICAL NOTES:\n-- Tirzepatide has a shorter half-life (5 days vs 7 days) which is why tirzepatide patients more commonly report food noise returning by day 4-5\n-- Patients switching from semaglutide to tirzepatide do not start at equivalent doses -- tirzepatide starts fresh at 2.5mg regardless of previous semaglutide dose\n-- Never reference brand names in patient communication. Use only: compounded semaglutide and compounded tirzepatide"},

    {name:"URGENCY RULES",nurse_name:"System",text:"These rules determine the urgency field in the JSON output.\n\nURGENT (urgency: urgent) -- requires immediate escalation, do not wait:\nPancreatitis symptoms: severe constant upper abdominal pain radiating to back, with nausea, vomiting, fever\nPersistent vomiting more than 3 days with inability to keep fluids down\nSigns of anaphylaxis: throat tightening, difficulty breathing, spreading hives, facial swelling -- call 911\nLoss of consciousness or seizure from hypoglycemia -- call 911\nSevere hypoglycemia not responsive to carbohydrate intake\nRapid heart rate with abdominal pain or fever\nBlood in vomit or stool\nSigns of acute kidney injury: no urination, severe dehydration, confusion\nSuicidal ideation\n\nSAME-DAY (urgency: same-day) -- needs provider review or follow-up today:\nModerate to severe GI symptoms affecting ability to eat or function for 2+ days\nInjection site reaction that is spreading, warm, or accompanied by fever\nConstipation more than 7 days\nSigns of moderate dehydration (dark urine, dizziness on standing, reduced urination)\nRight upper abdominal pain after meals (possible gallbladder)\nNew or worsening symptoms after dose increase that are not improving\nHypoglycemia episode that required treatment -- assess cause\n\nROUTINE (urgency: routine) -- next available response:\nMild nausea, heartburn, hair loss\nFood noise between injections\nWeight plateau questions\nNutrition and lifestyle questions\nDosing schedule questions without red flags\nGeneral check-in messages"},

    {name:"SIDE EFFECT SEVERITY CLASSIFICATION",nurse_name:"System",text:"Use this to determine clinical_routing_level for any message involving side effects.\n\nSEVERE (clinical_routing_level: severe) -- red flag, escalate to provider:\nVomiting lasting more than 3 consecutive days\nDiarrhea lasting more than 3 consecutive days\nConstipation lasting more than 7 consecutive days with pain or distension\nSevere abdominal pain (especially epigastric radiating to back -- pancreatitis)\nAny signs of allergic reaction beyond local injection site (spreading rash, hives, throat tightening, breathing difficulty)\nFever accompanying GI symptoms\nSevere back pain\nSigns of hypoglycemia with confusion, loss of consciousness, or inability to self-treat\nBlood in vomit or stool\nAny symptom the clinical picture suggests could be life-threatening\n\nMEDIUM (clinical_routing_level: moderate) -- needs follow-up, may need provider:\nModerate vomiting (frequent but less than 3 days, keeping some fluids down)\nModerate diarrhea (several times per day but less than 3 days, no dehydration)\nModerate nausea significantly affecting ability to eat\nAbdominal pain that is uncomfortable but not severe, no fever\nInjection site reaction with slight spreading\nFatigue affecting daily function significantly\nSymptoms persisting beyond expected timeframe without improvement\n\nLOW (clinical_routing_level: mild) -- education response appropriate:\nMild nausea (noticeable but not affecting food intake significantly)\nMild constipation (less than 7 days, manageable with OTC)\nHeartburn and reflux\nHair loss\nMild fatigue manageable with lifestyle adjustments\nMild injection site reactions (redness, minor swelling at site only)\n\nNOT A SIDE EFFECT (clinical_routing_level: none) -- do NOT set clinical_routing_flag:\nWeight plateau\nNo early weight loss\nFood noise (hunger or cravings returning between injections -- this is pharmacokinetics, not a side effect)\nDosing questions\nNutrition and lifestyle questions\nNon-clinical questions only\nGeneral check-in without symptom report"}
  ]
};

let kb = JSON.parse(JSON.stringify(DEFAULT_KB));
// Auth state
let currentUser = null;      // Supabase user object
let currentProfile = null;   // Profile + company data
let currentHistoryId = null;
let triageStartTime = null;
const SUPABASE_URL = 'https://aturbsnqpdtvhrnujrqb.supabase.co'; // Set via window.__RELAI_SUPABASE_URL__ at load
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0dXJic25xcGR0dmhybnVqcnFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc5MTgsImV4cCI6MjA5MzQyMzkxOH0.l7LdmI8PfFiIXa1nIwwauiWh6KnzpwhlpK5uieATsic'; // Set via window.__RELAI_SUPABASE_ANON_KEY__ at load

function getSession(){
  try{ return JSON.parse(localStorage.getItem('relai_session')||'null'); }catch(e){ return null; }
}
function getToken(){
  var s = getSession();
  return s ? s.access_token : null;
}
function getCompanyId(){
  if(!currentProfile) return null;
  var members = currentProfile.company_members;
  return members&&members[0]?members[0].company_id:null;
}
function getUserId(){
  return currentUser ? currentUser.id : null;
}



// Cache for KB section strings -- rebuilt only when KB changes
var kbCache = {};
var kbCacheKey = '';

function getKBSection(section, label){
  if(!kb[section]||!kb[section].length) return '';
  if(!kbCache[section]){
    kbCache[section] = '=== '+label+' ===\n'+kb[section].map(function(e){
      return '['+e.name+']\n'+e.text;
    }).join('\n\n');
  }
  return kbCache[section];
}

function invalidateKBCache(){ kbCache = {}; }

// Local message classifier -- runs client-side, zero cost, zero latency
// Returns array of relevant content types to include in KB prompt
function classifyMessage(msg){
  var m = msg.toLowerCase();
  var types = [];

  // Always include: rules + routing (small, always needed)
  types.push('rules');
  types.push('routing');

  // Non-clinical signals
  var nonClinical = /bill|pay|charg|invoice|refund|ship|track|deliver|package|order|account|subscri|cancel|prescription transfer|pharmacy|credit card|receipt/.test(m);
  if(nonClinical) types.push('routing_detail');

  // Side effect signals
  var sideEffect = /nausea|vomit|sick|diarrhea|constip|heartburn|reflux|hair|fatigue|tired|inject|site|react|itch|swell|rash|pain|hurt|ache|hypoglyc|shak|sweat|dizz|weak|fever|bleed/.test(m);
  if(sideEffect){ types.push('sideeffects'); types.push('protocols'); }

  // Weight/plateau/food signals
  var weightFocus = /weight|plateau|stall|loss|gain|scale|food noise|crav|hungry|hunger|calorie|eat|diet|appetite/.test(m);
  if(weightFocus) types.push('templates');

  // Dosing/injection signals
  var dosing = /dose|dosing|inject|units|mg|ml|syringe|vial|concentrat|titrat|missed|skip|forgot|storage|refriger|freez/.test(m);
  if(dosing){ types.push('protocols'); }

  // URLs only if likely giving advice (weight, plateau, food)
  if(weightFocus) types.push('urls');

  // If nothing clinical detected, still include sideeffects rules for classification
  if(!sideEffect && !weightFocus && !dosing) types.push('sideeffects');

  return [...new Set(types)]; // deduplicate
}

function getKBPrompt(msg){
  var types = msg ? classifyMessage(msg) : ['rules','routing','sideeffects','templates','protocols','urls'];
  var p = [];

  if(types.includes('rules'))
    p.push(getKBSection('notes','CLINICAL RULES (read first)'));
  if(types.includes('routing') || types.includes('routing_detail'))
    p.push(getKBSection('routing','ROUTING RULES'));
  if(types.includes('sideeffects'))
    p.push(getKBSection('sideeffects','SIDE EFFECT GUIDANCE'));
  if(types.includes('templates'))
    p.push(getKBSection('templates','RESPONSE TEMPLATES'));
  if(types.includes('protocols'))
    p.push(getKBSection('protocols','PROTOCOLS'));
  if(types.includes('urls'))
    p.push(getKBSection('urls','URLS'));

  return p.filter(Boolean).join('\n\n');
}

// NURSE







// API
// ── AUTH ──────────────────────────────────────────────────────────────────────
async function initAuth(){
  // Step 1: if magic link token arrived in URL hash, save it first
  var hash = window.location.hash;
  if(hash && hash.includes('access_token')){
    var p = new URLSearchParams(hash.replace('#',''));
    var token = p.get('access_token');
    var refresh = p.get('refresh_token');
    if(token){
      localStorage.setItem('relai_session', JSON.stringify({
        access_token: token,
        refresh_token: refresh || '',
        timestamp: Date.now()
      }));
      history.replaceState(null, '', window.location.pathname);
    }
  }

  // Step 2: check session
  var session = getSession();
  if(!session || !session.access_token){
    window.location.href = '/login.html';
    return;
  }
  try{
    var r = await fetch('/.netlify/functions/auth/profile',{
      headers:{'Authorization':'Bearer '+session.access_token}
    });
    var data = await r.json();
    if(!data.user || !data.user.id){
      localStorage.removeItem('relai_session');
      window.location.href = '/login.html';
      return;
    }
    currentUser = data.user;
    currentProfile = data.profile;
    // Set chip
    var name = (currentProfile&&currentProfile.full_name) || currentUser.email.split('@')[0];
    var initials = name.split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
    var chipEl = document.getElementById('staffChipName');
    var avatarEl = document.getElementById('chipAvatar');
    if(chipEl) chipEl.textContent = name.split(' ')[0]; // first name only
    if(avatarEl) avatarEl.textContent = initials;
    // Store name and department globally
    var dept = (currentProfile&&currentProfile.role)||'';
    window.currentNurse = name;
    window.currentDepartment = dept;
    // Show dept badge on chip
    var deptBadge = document.getElementById('staffDeptBadge');
    if(deptBadge){
      if(dept==='Clinical'){
        deptBadge.textContent='RN';
        deptBadge.style.display='';
        deptBadge.style.background='var(--blue-m)';
        deptBadge.style.color='var(--blue)';
        if(avatarEl) avatarEl.style.background='var(--blue)';
      } else if(dept==='Non-Clinical'){
        deptBadge.textContent='CS';
        deptBadge.style.display='';
        deptBadge.style.background='var(--amber-l)';
        deptBadge.style.color='var(--amber)';
        if(avatarEl) avatarEl.style.background='var(--amber)';
      }
    }
  }catch(e){
    // Network error — don't redirect, allow offline use
    window.currentNurse = 'Staff';
    var chipEl = document.getElementById('staffChipName');
    if(chipEl) chipEl.textContent = 'Offline';
  }
}


function openProfile(){
  if(!currentUser) return;
  var name = (currentProfile&&currentProfile.full_name)||currentUser.email.split('@')[0];
  var initials = name.split(' ').map(function(n){return n[0];}).join('').substring(0,2).toUpperCase();
  var email = currentUser.email||'';
  var role = (currentProfile&&currentProfile.role)||'staff';
  // Format role for display: 'Clinical' or 'Non-Clinical' with department context
  var roleLabel = role==='Clinical'?'Clinical Staff (RN)':role==='Non-Clinical'?'Non-Clinical Staff':role.charAt(0).toUpperCase()+role.slice(1);
  var members = currentProfile&&currentProfile.company_members;
  var company = members&&members[0]&&members[0].companies?members[0].companies.name:'Big Easy Weight Loss';
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileEmail').textContent = email;
  document.getElementById('profileRole').textContent = roleLabel;
  document.getElementById('profileCompany').textContent = company;
  document.getElementById('profileStats').textContent = 'Triages this session: ' + (window._sessionTriages||0);
  // Slide in
  document.getElementById('profilePanel').style.right = '0';
  document.getElementById('profileOverlay').style.display = 'block';
}

function closeProfile(){
  document.getElementById('profilePanel').style.right = '-360px';
  document.getElementById('profileOverlay').style.display = 'none';
}

function openHelpFromProfile(){
  closeProfile();
  // Find and click help tab
  var tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(function(t){
    if(t.textContent.includes('Help')){
      t.click();
    }
  });
}

async function signOut(){
  var token = getToken();
  if(token){
    try{
      await fetch('/.netlify/functions/auth/signout',{
        method:'POST',
        headers:{'Authorization':'Bearer '+token}
      });
    }catch(e){}
  }
  localStorage.removeItem('relai_session');
  window.location.href = '/login.html';
}


async function api(endpoint,method,body){
  var token=getToken();
  var hdrs={'Content-Type':'application/json'};
  if(token) hdrs['Authorization']='Bearer '+token;
  var opts={method:method||'GET',headers:hdrs};
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch('/.netlify/functions/kb'+endpoint,opts);
  return r.json().catch(function(){return{};});
}

async function loadKBFromServer(){
  try{
    setSyncBar('','Loading...');
    var rows=await api('/kb');
    if(Array.isArray(rows)&&rows.length>0){
      var nkb={sideeffects:[],templates:[],protocols:[],urls:[],routing:[],notes:[]};
      rows.forEach(function(row){
        // Migrate old 'protocols' side-effect entries to sideeffects section
        var s = row.section;
        if(!nkb[s]) s = (s==='snippets'?'notes':'notes');
        if(nkb[s]) nkb[s].push({name:row.name,text:row.content,nurse_name:row.nurse_name||'Unknown'});
      });
      kb=nkb; invalidateKBCache();
      setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    }else{
      // Empty DB -- seed with defaults and save so rules are in Supabase
      setSyncBar('','First run -- seeding knowledge base...');
      await saveKBSilent();
      setSyncBar('synced','Knowledge base seeded . '+new Date().toLocaleTimeString());
    }
    renderKB();
  }catch(e){setSyncBar('error','Could not load -- using local defaults');renderKB();}
}

function syncKBFromDOM(){
  document.querySelectorAll('.kb-entry-content').forEach(function(ta){
    var s=ta.getAttribute('data-section'),i=parseInt(ta.getAttribute('data-index'));
    if(kb[s]&&kb[s][i]!==undefined)kb[s][i].text=ta.value;
  });
  document.querySelectorAll('.kb-entry-name').forEach(function(inp){
    var s=inp.getAttribute('data-section'),i=parseInt(inp.getAttribute('data-index'));
    if(kb[s]&&kb[s][i]!==undefined)kb[s][i].name=inp.value;
  });
}

function buildEntries(){
  var entries=[],pos=0;
  ['sideeffects','templates','protocols','urls','routing','notes'].forEach(function(section){
    (kb[section]||[]).forEach(function(entry){
      entries.push({section:section,name:entry.name,content:entry.text,position:pos++,nurse_name:entry.nurse_name||window.currentNurse||'Unknown',user_id:(currentUser&&currentUser.id)||null,updated_at:new Date().toISOString()});
    });
  });
  return entries;
}

async function saveKBSilent(){
  syncKBFromDOM();
  await api('/kb','POST',{entries:buildEntries()});
}

async function submitEntry(){
  var title=document.getElementById('entryTitle').value.trim();
  var content=document.getElementById('entryContent').value.trim();
  var section=document.getElementById('entrySection').value;
  if(!title||!content){alert('Please enter both a title and content.');return;}
  var btn=document.getElementById('entrySubmitBtn'),txt=document.getElementById('entrySubmitTxt'),spin=document.getElementById('entrySpinner');
  btn.disabled=true;txt.textContent='Saving...';spin.className='spinner active';
  try{
    if(!kb[section])kb[section]=[];
    kb[section].push({name:title,text:content,nurse_name:window.currentNurse||(currentProfile&&currentProfile.full_name)||"Staff"}); invalidateKBCache();
    await saveKBSilent();
    document.getElementById('entryTitle').value='';
    document.getElementById('entryContent').value='';
    renderKB();showToast('Saved and synced');
  }catch(e){alert('Error: '+e.message);}
  finally{btn.disabled=false;txt.textContent='Save & Sync to Team';spin.className='spinner';}
}

async function saveKB(){
  syncKBFromDOM();
  var btn=document.getElementById('kbSaveBtn'),txt=document.getElementById('kbSaveTxt'),spin=document.getElementById('kbSpinner');
  btn.disabled=true;txt.textContent='Syncing...';spin.className='kb-spinner active';
  try{
    await api('/kb','POST',{entries:buildEntries()}); invalidateKBCache();
    setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    showToast('Knowledge base synced');
  }catch(e){setSyncBar('error','Sync failed');}
  finally{btn.disabled=false;txt.textContent='Save & Sync to Team';spin.className='kb-spinner';}
}


function computeUrgencyScore(urgency, routingLevel, hasSideEffect){
  // Base score from urgency
  var base = urgency==='urgent' ? 9 : urgency==='same-day' ? 6 : 3;
  // Severity modifier
  var sev = routingLevel==='severe' ? 2 : routingLevel==='moderate' ? 1 : 0;
  // Cap at 10
  return Math.min(10, base + (hasSideEffect ? sev : 0));
}

async function saveHistoryRecord(parsed,msg){
  var userName = (currentProfile&&currentProfile.full_name)||(currentUser&&currentUser.email)||window.currentNurse||'Staff';
  var userId = getUserId();
  var companyId = getCompanyId();
  if(!userName) return null;
  try{
    var hasSE = parsed.clinical_routing_flag && (parsed.clinical_routing_level||'none')!=='none';
    var score = computeUrgencyScore(parsed.urgency, parsed.clinical_routing_level||'none', hasSE);
    var payload={nurse_name:userName,patient_message:msg,
      clinical_category:parsed.clinical_category,urgency_original:parsed.urgency,urgency_override:null,
      urgency_score:score,
      clinical_routing_level:parsed.clinical_routing_level||'none',
      routed_to:parsed.routed_to||null,
      non_clinical_flag:parsed.non_clinical_flag,non_clinical_items:parsed.non_clinical_items||[],
      follow_up_questions:parsed.follow_up_questions||[],
      draft_response:parsed.draft_response||''
    };
    if(userId) payload.user_id=userId;
    if(companyId) payload.company_id=companyId;
    var r=await api('/history','POST',payload);
    triageStartTime = Date.now();
    window._sessionTriages = (window._sessionTriages||0) + 1;
    return Array.isArray(r)&&r[0]?r[0].id:null;
  }catch(e){return null;}
}

// KB UI
function setSyncBar(state,msg){
  var bar=document.getElementById('syncBar');if(!bar)return;
  bar.className='kb-sync-bar'+(state?' '+state:'');
  var sm=document.getElementById('syncMsg');if(sm)sm.textContent=msg;
}
function renderKB(){
  // Only render if KB tab elements exist in DOM
  if(!document.getElementById('protocols-list'))return;
  ['sideeffects','templates','protocols','urls','routing','notes'].forEach(function(section){
    var list=document.getElementById(section+'-list');
    if(!list)return;
    list.innerHTML='';
    var items=kb[section]||[];
    var cnt=document.getElementById('cnt-'+section);
    if(cnt)cnt.textContent=items.length||'';
    if(!items.length){list.innerHTML='<div class="empty-state">No entries yet. Add one above.</div>';return;}
    items.forEach(function(entry,i){list.appendChild(makeEntryEl(section,i,entry));});
  });
}
function makeEntryEl(section,i,entry){
  var div=document.createElement('div');
  div.className='kb-entry';
  var nm=(entry.name||'');
  var isRule=nm.includes('RULES')||nm.includes('CLASSIFICATION')||nm.includes('FRAMEWORK');
  if(isRule)div.classList.add('kb-entry-collapsed');

  var header=document.createElement('div');header.className='kb-entry-header';

  var nameInp=document.createElement('input');
  nameInp.className='kb-entry-name';nameInp.type='text';nameInp.value=nm;
  nameInp.setAttribute('data-section',section);nameInp.setAttribute('data-index',i);
  nameInp.placeholder='Entry name...';

  var toggleBtn=document.createElement('button');
  toggleBtn.className='kb-entry-toggle';
  toggleBtn.textContent=isRule?'expand':'collapse';
  toggleBtn.addEventListener('click',function(){toggleKBEntry(toggleBtn,div);});

  var author=document.createElement('span');
  author.className='kb-entry-author';
  author.textContent=entry.nurse_name||'Unknown';

  header.appendChild(nameInp);header.appendChild(toggleBtn);header.appendChild(author);

  var ta=document.createElement('textarea');
  ta.className='kb-entry-content';
  ta.setAttribute('data-section',section);ta.setAttribute('data-index',i);
  ta.value=entry.text||'';

  var footer=document.createElement('div');footer.className='kb-entry-footer';

  var saveBtn=document.createElement('button');
  saveBtn.className='btn-xs save';saveBtn.textContent='Save';
  saveBtn.addEventListener('click',function(){saveEntryInline(section,i,saveBtn);});

  var delBtn=document.createElement('button');
  delBtn.className='btn-xs danger';delBtn.textContent='Delete';
  delBtn.addEventListener('click',function(){removeEntry(section,i);});

  footer.appendChild(saveBtn);footer.appendChild(delBtn);
  div.appendChild(header);div.appendChild(ta);div.appendChild(footer);
  return div;
}
async function saveEntryInline(section,i,btn){
  syncKBFromDOM();
  if(currentNurse&&kb[section]&&kb[section][i])kb[section][i].nurse_name=currentNurse;
  btn.textContent='Saving...';btn.disabled=true;
  try{
    await saveKBSilent();
    btn.textContent='Saved';btn.className='btn-xs saved';
    setTimeout(function(){btn.textContent='Save';btn.className='btn-xs save';btn.disabled=false;},2000);
    setSyncBar('synced','Synced . '+new Date().toLocaleTimeString());
    renderKB();
  }catch(e){btn.textContent='Save';btn.disabled=false;}
}
function removeEntry(section,i){if(!confirm('Delete this entry?'))return;kb[section].splice(i,1);renderKB();}
function exportKB(){
  var blob=new Blob([JSON.stringify({kb:kb},null,2)],{type:'application/json'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='glp1-kb-backup.json';a.click();
}
function importKB(e){
  var file=e.target.files[0];if(!file)return;
  var reader=new FileReader();
  reader.onload=function(ev){
    try{var data=JSON.parse(ev.target.result);if(data.kb)kb=data.kb;renderKB();setSyncBar('','Imported -- save to sync');}
    catch(err){alert('Invalid backup file.');}
  };
  reader.readAsText(file);
}

// TABS
function togglePrior(){
  var panel = document.getElementById('priorContextPanel');
  var btn = document.getElementById('priorToggle');
  var open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  btn.textContent = open ? 'Add Prior Context' : 'Remove Context';
  btn.style.borderColor = open ? 'var(--gray-200)' : 'var(--blue-m)';
  btn.style.color = open ? 'var(--gray-500)' : 'var(--blue)';
  btn.style.background = open ? 'none' : 'var(--blue-l)';
  if(open) document.getElementById('priorInput').value = '';
  document.getElementById('msgLabel').textContent = open ? 'Current Message' : 'Latest Reply';
}

function switchKBTab(section, btn){
  document.querySelectorAll('.kb-tab').forEach(function(b){b.classList.remove('active');});
  document.querySelectorAll('.kb-tab-panel').forEach(function(p){p.classList.remove('active');});
  btn.classList.add('active');
  var panel = document.getElementById('kb-tab-'+section);
  if(panel) panel.classList.add('active');
  document.getElementById('kbSearch').value = '';
}

function filterKBEntries(){
  var q = document.getElementById('kbSearch').value.toLowerCase().trim();
  document.querySelectorAll('.kb-entry').forEach(function(entry){
    var name = (entry.querySelector('.kb-entry-name')||{}).value||'';
    var text = (entry.querySelector('.kb-entry-content')||{}).value||'';
    var match = !q || name.toLowerCase().includes(q) || text.toLowerCase().includes(q);
    entry.style.display = match ? '' : 'none';
  });
}

function toggleKBEntry(btn, entryEl){
  entryEl.classList.toggle('kb-entry-collapsed');
  btn.textContent = entryEl.classList.contains('kb-entry-collapsed') ? 'v expand' : '^ collapse';
}

function toggleFaq(btn){
  var isOpen = btn.classList.contains('open');
  // Close all open FAQs in the same section
  var section = btn.closest('.help-section');
  if(section){
    section.querySelectorAll('.help-faq-q.open').forEach(function(b){
      b.classList.remove('open');
      var a = b.nextElementSibling;
      if(a) a.classList.remove('open');
    });
  }
  // Toggle clicked one (unless it was already open)
  if(!isOpen){
    btn.classList.add('open');
    var ans = btn.nextElementSibling;
    if(ans) ans.classList.add('open');
  }
}

function switchTab(name,btn){
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active');});
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  document.getElementById('tab-'+name).classList.add('active');
  btn.classList.add('active');
  if(name==='kb')loadKBFromServer();
  if(name==='history')loadReviews();
}

// TRIAGE
function setLoading(on){
  document.getElementById('btnText').textContent=on?'Analyzing...':'Run Triage';
  document.getElementById('btnSpinner').className=on?'spinner active':'spinner';
  document.getElementById('triageBtn').disabled=on;
}

async function runTriage(){
  var msg=document.getElementById('msgInput').value.trim();
  if(!msg)return;
  setLoading(true);
currentHistoryId=null;
  document.getElementById('results').innerHTML='<div class="placeholder"><div class="spinner active" style="width:26px;height:26px;border-color:var(--gray-300);border-top-color:var(--blue);"></div><div class="placeholder-text" style="margin-top:14px;">Analyzing message...</div></div>';
  var kbContent=getKBPrompt(msg);
  var sysPrompt=kbContent?BASE_PROMPT+'\n\n'+kbContent:BASE_PROMPT;


  // Build user content -- include prior conversation if provided
  var prior = (document.getElementById('priorInput')||{}).value||'';
  prior = prior.trim();
  var userContent = prior
    ? 'PRIOR CONVERSATION CONTEXT (earlier thread -- for background only, do not respond to this directly):\n\n' + prior + '\n\n---\n\nLATEST PATIENT MESSAGE (triage and respond to this):\n\n' + msg
    : msg;

  try{
    var res=await fetch('/.netlify/functions/triage',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:1024,system:sysPrompt,messages:[{role:'user',content:userContent}]})
    });
    var data=await res.json();
    if(data.error)throw new Error(typeof data.error==='string'?data.error:(data.error.message||JSON.stringify(data.error)));
    var raw=(data.content||[]).map(function(b){return b.text||'';}).join('');
    if(!raw)throw new Error('Empty response from API.');
    var parsed=JSON.parse(raw.replace(/```json|```/g,'').trim());
    renderResults(parsed);
    saveHistoryRecord(parsed,msg).then(function(id){
      currentHistoryId=id;
      // Save review request if AI flagged low confidence
      if(parsed.review_request && parsed.review_request.question){
        saveReviewRequest(parsed.review_request, msg, parsed.draft_response, id);
      }
    });
  }catch(err){
    var msg = err.message||'Unknown error';
    var isJson = msg.includes('JSON') || msg.includes('Unexpected token') || msg.includes('SyntaxError');
    var isEmpty = msg.includes('Empty response');
    var isTimeout = msg.includes('timeout') || msg.includes('network') || msg.toLowerCase().includes('fetch');
    var title, detail, suggestion;
    if(isJson || isEmpty){
      title = 'Response could not be parsed';
      detail = 'The AI returned a response but it was incomplete or in an unexpected format. This usually happens when the knowledge base is very large and the response gets cut off.';
      suggestion = 'Try again -- if it keeps failing, go to the Knowledge Base and check for any very long entries that could be trimmed.';
    } else if(isTimeout){
      title = 'Connection issue';
      detail = 'The request could not reach the server, or took too long to respond.';
      suggestion = 'Check your internet connection and try again.';
    } else {
      title = 'Triage could not complete';
      detail = msg;
      suggestion = 'Try submitting again. If the error persists, the message may contain content the AI cannot process -- try simplifying or rephrasing it.';
    }
    document.getElementById('results').innerHTML =
      '<div style="background:var(--amber-l);border:1.5px solid var(--amber-m);border-radius:12px;padding:20px 22px;">'+
        '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--amber);margin-bottom:8px;">&#9888; '+esc(title)+'</div>'+
        '<div style="font-size:var(--fs-base);color:var(--gray-800);line-height:1.7;margin-bottom:10px;">'+esc(detail)+'</div>'+
        '<div style="font-size:var(--fs-sm);color:var(--gray-600);line-height:1.6;padding:10px 14px;background:rgba(255,255,255,.6);border-radius:8px;">'+
          '<strong>What to do:</strong> '+esc(suggestion)+
        '</div>'+
      '</div>';
  }finally{setLoading(false);}
}









function buildTimeframeSelect(urgency){
  var mapped=urgency==='urgent'?'urgent':urgency==='same-day'?'same-day':'routine';
  return '<select class="editable-select '+mapped+'" id="timeframeSelect" style="width:auto;max-width:160px;" onchange="onTimeframeChange(this)">'+
    TIMEFRAMES.map(function(o){return '<option value="'+o.v+'"'+(o.v===mapped?' selected':'')+'>'+o.l+'</option>';}).join('')+
  '</select>';
}

function onTimeframeChange(sel){
  var v=sel.value;
  sel.className='editable-select '+(v==='urgent'?'urgent':v==='routine'?'routine':'same-day');
  var btn=document.getElementById('timeframeSaveBtn');
  // checkmark button — no text change needed
}

async function saveTimeframe(){
  var sel=document.getElementById('timeframeSelect'),btn=document.getElementById('timeframeSaveBtn');
  if(!sel||!btn)return;
  var orig=btn.style.background;
  btn.style.background='var(--gray-300)';btn.disabled=true;
  if(currentHistoryId)await api('/history','POST',{action:'update_urgency',id:currentHistoryId,urgency_override:sel.value});
  btn.style.background='var(--green)';
  setTimeout(function(){btn.style.background='var(--green)';btn.disabled=false;},1200);
}

// VOTING






// CORRECTION
async function submitCorrection(){
  var actual=document.getElementById('correctionInput').value.trim();
  if(!actual){alert('Please paste the response you actually sent.');return;}
  var btn=document.getElementById('correctionSubmitBtn');
  var status=document.getElementById('correctionStatus');
  btn.disabled=true;btn.querySelector('span').textContent='Analyzing...';
  status.textContent='';status.className='learn-status';
  try{
    if(currentHistoryId)await api('/history','POST',{action:'save_actual',id:currentHistoryId,actual_response:actual,correction_note:''});
    var aiDraft=document.getElementById('aiDraftText')?document.getElementById('aiDraftText').innerText:'';
    // Collect category corrections as additional context for the learning note
    var catPills=document.querySelectorAll('.cat-pill.sel-clin');
    var catNote='';
    if(catPills.length){
      var catVals=[].map.call(catPills,function(p){return p.getAttribute('data-val');}).join(', ');
      if(catVals) catNote='\n\nCategory selected by staff: '+catVals+'.';
    }
    var tfEl=document.getElementById('timeframeSelect');
    if(tfEl) catNote+=' Timeframe: '+tfEl.value+'.';
    var analyzeRes=await fetch('/.netlify/functions/kb/analyze',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-haiku-4-5',max_tokens:200,
        system:'Compare an AI draft clinical response with what the nurse actually sent. Output 2-3 sentences: what changed, what this reveals about the AI gap, one improvement suggestion. Plain text only.',
        messages:[{role:'user',content:'AI draft:\n'+aiDraft+'\n\nActual sent:\n'+actual+catNote}]
      })
    });
    var analyzeData=await analyzeRes.json();
    var note=(analyzeData.content||[]).map(function(b){return b.text||'';}).join('').trim();
    var duration = triageStartTime ? Math.round((Date.now()-triageStartTime)/1000) : null;
    if(currentHistoryId)await api('/history','POST',{action:'save_actual',id:currentHistoryId,actual_response:actual,correction_note:note,session_duration_seconds:duration});
    status.textContent=note?'OK Saved. Learning note: "'+note.substring(0,90)+(note.length>90?'...':'')+'"':'OK Response saved.';
    status.className='learn-status success';
    document.getElementById('correctionInput').value='';
  }catch(e){status.textContent='Error: '+e.message;status.className='learn-status error';}
  finally{btn.disabled=false;btn.querySelector('span').textContent='Submit & Learn';}
}

// RENDER
// Severity badge reads exclusively from clinical_routing_level -- set by AI using KB rules
// No hardcoded category lists or fallback inference. Single source of truth.
function buildSeverityBadge(routingLevel){
  var level = (routingLevel||'none').toLowerCase();
  var map = {
    'severe': {cls:'sev-severe', label:'Side Effect: Severe'},
    'moderate': {cls:'sev-medium', label:'Side Effect: Moderate'},
    'mild': {cls:'sev-low', label:'Side Effect: Mild'}
  };
  var sev = map[level];
  if(!sev) return '';
  return '<div class="severity-badge '+sev.cls+'"><div class="sev-dot"></div>'+sev.label+'</div>';
}

function renderResults(d){
  var html='';
  var draftText=(d.draft_response||'').trim();
  var draftIsEmpty=!draftText;
  var severityBadge=buildSeverityBadge(d.clinical_routing_level);
  var hasSideEffect=d.clinical_routing_flag&&(d.clinical_routing_level||'none')!=='none';
  var aiClinCat=(d.clinical_category||'').trim();
  var aiNonClin=(d.non_clinical_items&&d.non_clinical_items.length)?d.non_clinical_items.join(', '):'';
  var _in=d.internal_note||'';
  var routedTo=d.routed_to||'Support Team';
  var hasNonClin=!!(d.non_clinical_flag&&d.non_clinical_items&&d.non_clinical_items.length);
  var isClinical=!!(aiClinCat&&aiClinCat!=='General/multiple');
  var taskType=hasNonClin&&isClinical?'Dual Task':hasNonClin?'Non-Clinical':'Clinical';

  // Build pills
  var ncCats=['Billing/Payment','Shipment/Tracking','Account/Subscription','Refund Request','General Inquiry','Complaint/Concern'];
  var clinPills=CLINICAL_CATS.map(function(c){
    var sel=c===aiClinCat;
    return '<button class="cat-pill'+(sel?' sel-clin':'')+'" data-val="'+esc(c)+'" data-type="clin">'+esc(c)+'</button>';
  }).join(' ');
  var ncPills=ncCats.map(function(c){
    var sel=aiNonClin.includes(c);
    return '<button class="cat-pill'+(sel?' sel-nc':'')+'" data-val="'+esc(c)+'" data-type="nc">'+esc(c)+'</button>';
  }).join(' ');

  // ── Two side-by-side top cards ────────────────────────────────────────────
  html+=
    '<div style="display:grid;grid-template-columns:minmax(200px,240px) 1fr;gap:12px;align-items:start;">'+

      // LEFT — Status + timeframe editable
      '<div class="out-card">'+
        '<div class="oc-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:0;">'+

          // Task type only — no category (categories handled on right card)
          '<div style="padding-bottom:12px;">'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-500);font-weight:600;">Task type: <span style="color:var(--gray-800);font-weight:700;">'+taskType+'</span></div>'+
          '</div>'+

          // Severity + escalation validation — only when side effect detected
          (hasSideEffect&&isClinical?
            '<div style="padding:10px 0;border-top:1px solid var(--gray-100);">'+
              severityBadge+
              '<div style="margin-top:10px;">'+
                '<div style="font-size:var(--fs-xs);color:var(--gray-500);font-weight:600;margin-bottom:6px;">Severity correct?</div>'+
                '<div style="display:flex;gap:6px;">'+
                  '<button id="escYesBtn" class="esc-btn yes" onclick="recordEscalation(true)">&#10003; Yes</button>'+
                  '<button id="escNoBtn" class="esc-btn no" onclick="recordEscalation(false)">&#10007; No</button>'+
                '</div>'+
              '</div>'+
            '</div>'
          :'')+

          // Timeframe — with divider, dropdown + green checkmark button
          '<div style="padding-top:12px;border-top:1px solid var(--gray-100);">'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-500);font-weight:600;margin-bottom:6px;">Response Timeframe</div>'+
            '<div style="display:flex;align-items:center;gap:6px;">'+
              buildTimeframeSelect(d.urgency)+
              '<button id="timeframeSaveBtn" onclick="saveTimeframe()" title="Save timeframe" style="flex-shrink:0;width:30px;height:30px;border-radius:7px;border:none;background:var(--green);color:white;cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .2s;">&#10003;</button>'+
            '</div>'+
          '</div>'+

        '</div>'+
      '</div>'+

      // RIGHT — Category correction pills
      '<div class="out-card">'+
        '<div class="oc-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;">'+
          '<div>'+
            '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:7px;">Clinical Category</div>'+
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+clinPills+'</div>'+
          '</div>'+
          (hasNonClin?
            '<div style="padding-top:10px;border-top:1px solid var(--gray-100);">'+
              '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:7px;">Non-Clinical Category</div>'+
              '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+ncPills+'</div>'+
            '</div>'
          :'')+
          '<div style="padding-top:10px;border-top:1px solid var(--gray-100);display:flex;justify-content:flex-end;">'+
            '<button class="cat-save-btn" id="catSaveBtn" onclick="saveCategoryTags()">Save</button>'+
          '</div>'+
        '</div>'+
      '</div>'+

    '</div>';

  // ── Routing card — no "clinical first" notice, just the task ─────────────
  if(hasNonClin){
    html+=
      '<div class="out-card" style="border-color:var(--amber-m);">'+
        '<div class="oc-header">'+
          '<span class="oc-label" style="color:var(--amber);">&#128203; Route to Support Team</span>'+
          '<span style="font-size:var(--fs-sm);font-weight:700;color:var(--gray-800);">'+esc(routedTo)+'</span>'+
        '</div>'+
        '<div class="oc-body">'+
          (_in?
            '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-700);margin-bottom:5px;">Internal Note &mdash; paste into Bask chat</div>'+
            '<div style="font-size:var(--fs-xs);color:var(--gray-600);line-height:1.5;margin-bottom:8px;">Copy &rarr; open Bask chat &rarr; submit as internal note &rarr; assign to <strong>'+esc(routedTo)+'</strong></div>'+
            '<div style="background:var(--amber-l);border:1.5px solid var(--amber-m);border-radius:8px;padding:13px 16px;font-size:var(--fs-base);color:var(--gray-800);line-height:1.75;position:relative;">'+
              esc(_in)+
              '<button class="copy-inline-btn" data-copy-target="internal" style="position:absolute;top:8px;right:8px;background:var(--white);border:1.5px solid var(--amber-m);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;color:var(--amber);font-weight:600;">Copy</button>'+
            '</div>'
          :
            '<div style="font-size:var(--fs-sm);color:var(--gray-600);">No internal note generated. Run triage again if unexpected.</div>'
          )+
        '</div>'+
      '</div>';
  }

  // ── Generated Response ────────────────────────────────────────────────────
  html+=
    '<div class="out-card" style="border-color:'+(draftIsEmpty?'var(--red-m)':'var(--teal-m)')+'">'+
      '<div class="oc-header">'+
        '<span class="oc-label" style="color:'+(draftIsEmpty?'var(--red)':'var(--teal)')+'">'+
          (draftIsEmpty?'&#9888; Response Not Generated':'Generated Response for Patient')+
        '</span>'+
      '</div>'+
      '<div class="oc-body">'+
        (draftIsEmpty?
          '<div style="background:var(--red-l);border:1.5px solid var(--red-m);border-radius:8px;padding:14px 16px;font-size:var(--fs-sm);color:var(--red);line-height:1.7;"><strong>The AI did not generate a response.</strong> Click <strong>Run Triage again</strong>.</div>'
        :
          '<div style="position:relative;margin-bottom:20px;">'+
            '<div class="response-text" id="aiDraftText">'+esc(draftText).split('\n').join('<br>')+'</div>'+
            '<button class="copy-inline-btn" data-copy-target="draft" style="position:absolute;top:8px;right:8px;background:var(--white);border:1.5px solid var(--gray-200);border-radius:6px;padding:4px 9px;cursor:pointer;font-size:12px;color:var(--gray-500);">Copy</button>'+
          '</div>'
        )+
        '<div style="height:1px;background:var(--gray-200);margin:20px 0 12px;"></div><div class="feedback-row"><button class="vote-btn up" id="upvoteBtn">&#128077; Good response</button><button class="vote-btn down" id="downvoteBtn">&#128078; Needs work</button></div>'+
        '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--gray-100);">'+
          '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-600);margin-bottom:6px;">What was sent to the patient</div>'+
          '<p style="font-size:var(--fs-sm);color:var(--gray-700);margin-bottom:8px;line-height:1.5;">Paste your actual response if you changed the draft. The AI learns by comparing what you sent to what it generated.</p>'+
          '<textarea id="correctionInput" style="min-height:90px;font-size:var(--fs-sm);" placeholder="Paste the message you sent to the patient..."></textarea>'+
          '<div class="correction-submit-row" style="margin-top:8px;">'+
            '<button class="correction-submit-btn" id="correctionSubmitBtn" onclick="submitCorrection()"><span>Submit &amp; Learn</span><div class="spinner" id="correctionSpinner"></div></button>'+
            '<div class="learn-status" id="correctionStatus"></div>'+
          '</div>'+
        '</div>'+
      '</div>'+
    '</div>';

  var el=document.getElementById('results');
  el.innerHTML=html;

  el.querySelectorAll('.copy-inline-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var target=btn.getAttribute('data-copy-target');
      var text=target==='internal'?_in:draftText;
      if(!text)return;
      navigator.clipboard.writeText(text).then(function(){
        var orig=btn.textContent;btn.textContent='Copied!';btn.style.color='var(--green)';
        setTimeout(function(){btn.textContent=orig;btn.style.color='';},2000);
      });
    });
  });

  var upBtn=document.getElementById('upvoteBtn');
  var dnBtn=document.getElementById('downvoteBtn');
  if(upBtn) upBtn.addEventListener('click',function(){ castVote('up',upBtn); });
  if(dnBtn) dnBtn.addEventListener('click',function(){ castVote('down',dnBtn); });

  el.querySelectorAll('.cat-pill').forEach(function(pill){
    pill.addEventListener('click',function(){
      var type=pill.getAttribute('data-type');
      if(type==='clin') pill.classList.toggle('sel-clin');
      else pill.classList.toggle('sel-nc');
    });
  });
}


var correctionsLoaded = false;

function toggleCorrectionsPanel(){
  var panel=document.getElementById('corrections-panel');
  var btn=document.getElementById('loadCorrectionsBtn');
  var open=panel.style.display!=='none';
  panel.style.display=open?'none':'block';
  btn.textContent=open?'v Load':'^ Hide';
  if(!open&&!correctionsLoaded)loadCorrections();
}

async function loadCorrections(){
  correctionsLoaded=true;
  var list=document.getElementById('corrections-list');
  list.innerHTML='<div class="empty-state">Loading corrections...</div>';
  try{
    var rows=await api('/history');
    var withCorr=Array.isArray(rows)?rows.filter(function(r){return r.actual_response_sent||r.correction_note;}):[];
    if(!withCorr.length){list.innerHTML='<div class="empty-state">No corrections saved yet.</div>';return;}
    list.innerHTML='';
    withCorr.forEach(function(r){
      var date=new Date(r.created_at).toLocaleDateString();

      // Build card with DOM so delete button closure works cleanly
      var card=document.createElement('div');
      card.style.cssText='border:1.5px solid var(--gray-200);border-radius:10px;margin-bottom:12px;overflow:hidden;';

      // Header row
      var hdr=document.createElement('div');
      hdr.style.cssText='padding:9px 13px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);display:flex;justify-content:space-between;align-items:center;gap:8px;';

      var meta=document.createElement('div');
      meta.style.cssText='display:flex;align-items:center;gap:10px;flex:1;min-width:0;';

      var nameSpan=document.createElement('span');
      nameSpan.style.cssText='font-size:var(--fs-xs);font-weight:600;color:var(--gray-700);';
      nameSpan.textContent=r.nurse_name+' · '+date;

      var catSpan=document.createElement('span');
      catSpan.style.cssText='font-size:var(--fs-xs);color:var(--gray-500);';
      catSpan.textContent=r.clinical_category||'';

      meta.appendChild(nameSpan);
      meta.appendChild(catSpan);

      var delBtn=document.createElement('button');
      delBtn.textContent='Delete';
      delBtn.style.cssText='padding:3px 10px;font-size:11px;font-weight:600;border:1.5px solid var(--red-m);border-radius:6px;background:var(--white);color:var(--red);cursor:pointer;flex-shrink:0;font-family:var(--sans);';
      delBtn.addEventListener('click',function(){deleteCorrection(r.id,card,delBtn);});

      hdr.appendChild(meta);
      hdr.appendChild(delBtn);
      card.appendChild(hdr);

      // Body — side-by-side drafts
      var body=document.createElement('div');
      body.style.cssText='padding:12px 14px;display:grid;grid-template-columns:1fr 1fr;gap:12px;';

      var draftDiv=document.createElement('div');
      var draftLabel=document.createElement('div');
      draftLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);margin-bottom:6px;';
      draftLabel.textContent='AI Draft';
      var draftText=document.createElement('div');
      draftText.style.cssText='font-size:var(--fs-xs);color:var(--gray-600);line-height:1.6;white-space:pre-wrap;';
      var dr=r.draft_response||'';
      draftText.textContent=dr.length>280?dr.substring(0,280)+'...':dr;
      draftDiv.appendChild(draftLabel);
      draftDiv.appendChild(draftText);

      var sentDiv=document.createElement('div');
      var sentLabel=document.createElement('div');
      sentLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--teal);margin-bottom:6px;';
      sentLabel.textContent='Actually Sent';
      var sentText=document.createElement('div');
      sentText.style.cssText='font-size:var(--fs-xs);color:var(--gray-700);line-height:1.6;white-space:pre-wrap;';
      var sr=r.actual_response_sent||'';
      sentText.textContent=sr.length>280?sr.substring(0,280)+'...':sr;
      sentDiv.appendChild(sentLabel);
      sentDiv.appendChild(sentText);

      body.appendChild(draftDiv);
      body.appendChild(sentDiv);
      card.appendChild(body);

      // Learning note if present
      if(r.correction_note){
        var noteRow=document.createElement('div');
        noteRow.style.cssText='padding:8px 14px 12px;border-top:1px solid var(--gray-100);';
        var noteLabel=document.createElement('div');
        noteLabel.style.cssText='font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange);margin-bottom:4px;';
        noteLabel.textContent='Learning note';
        var noteText=document.createElement('div');
        noteText.style.cssText='font-size:var(--fs-xs);color:var(--gray-700);line-height:1.6;';
        noteText.textContent=r.correction_note;
        noteRow.appendChild(noteLabel);
        noteRow.appendChild(noteText);
        card.appendChild(noteRow);
      }

      list.appendChild(card);
    });
  }catch(e){list.innerHTML='<div class="empty-state" style="color:var(--red);">Error: '+esc(e.message)+'</div>';}
}

async function deleteCorrection(id,cardEl,btn){
  if(!confirm('Delete this correction? This removes the learned note and cannot be undone.'))return;
  btn.textContent='Deleting...';
  btn.disabled=true;
  try{
    await api('/history','POST',{action:'delete_correction',id:id});
    cardEl.style.opacity='0';
    cardEl.style.transition='opacity .3s';
    setTimeout(function(){
      if(cardEl.parentNode)cardEl.parentNode.removeChild(cardEl);
      var list=document.getElementById('corrections-list');
      if(list&&!list.querySelector('div[style*="border"]')){
        list.innerHTML='<div class="empty-state">No corrections saved yet.</div>';
      }
    },300);
    showToast('Correction deleted');
  }catch(e){
    btn.textContent='Delete';
    btn.disabled=false;
    showToast('Error deleting correction');
  }
}

function toggleCatTag(btn){
  var type=btn.getAttribute('data-type');
  var selClass=type==='clin'?'sel-clin':'sel-nc';
  // For clinical: single select (radio style)
  if(type==='clin'){
    btn.closest('.out-card').querySelectorAll('.cat-tag[data-type="clin"]').forEach(function(t){ t.classList.remove('sel-clin'); });
  }
  btn.classList.toggle(selClass);
}


async function saveCategoryTags(){
  var btn=document.getElementById('catSaveBtn');
  if(!btn||!currentHistoryId)return;
  btn.textContent='Saving...';btn.disabled=true;
  var clinVals=[],ncVals=[];
  document.querySelectorAll('.cat-pill.sel-clin').forEach(function(p){clinVals.push(p.getAttribute('data-val'));});
  document.querySelectorAll('.cat-pill.sel-nc').forEach(function(p){ncVals.push(p.getAttribute('data-val'));});
  // Also save timeframe in same call
  var tfSel=document.getElementById('timeframeSelect');
  var saves=[api('/history','POST',{action:'update_category',id:currentHistoryId,category:(clinVals.join(', ')||'')+(ncVals.length?' | Non-clinical: '+ncVals.join(', '):'')})];
  if(tfSel) saves.push(api('/history','POST',{action:'update_urgency',id:currentHistoryId,urgency_override:tfSel.value}));
  await Promise.all(saves);
  btn.textContent='Saved';btn.className='cat-save-btn saved';
  setTimeout(function(){btn.textContent='Save';btn.className='cat-save-btn';btn.disabled=false;},2000);
}


async function recordEscalation(correct){
  if(!currentHistoryId){ showToast('Run a triage first','warn'); return; }
  var yBtn=document.getElementById('escYesBtn');
  var nBtn=document.getElementById('escNoBtn');
  // Visual feedback using CSS classes
  if(yBtn){ yBtn.disabled=true; yBtn.className='esc-btn yes'+(correct?' selected-yes':''); }
  if(nBtn){ nBtn.disabled=true; nBtn.className='esc-btn no'+(!correct?' selected-no':''); }
  if(yBtn&&!correct) yBtn.style.opacity='0.4';
  if(nBtn&&correct) nBtn.style.opacity='0.4';
  try{
    await api('/history','POST',{action:'update_escalation',id:currentHistoryId,correct:correct});
    showToast(correct?'Severity confirmed ✓':'Severity flagged — will review');
  }catch(e){ showToast('Error saving','error'); }
}


async function castVote(type, btn){
  if(!currentHistoryId){ showToast('Run a triage first','warn'); return; }
  if(btn.classList.contains('active')) return;
  try{
    await api('/history','POST',{action: type==='up'?'upvote':'downvote', id:currentHistoryId, reason: type==='up'?'Good response':'Needs improvement'});
    var up=document.getElementById('upvoteBtn'), dn=document.getElementById('downvoteBtn');
    if(up) up.classList.remove('active');
    if(dn) dn.classList.remove('active');
    btn.classList.add('active');
    showToast(type==='up'?'Positive feedback saved':'Flagged for review');
  } catch(e){ showToast('Error saving feedback'); }
}

async function loadHistory(){
  var filter = document.getElementById('historyFilter');
  var filterVal = filter ? filter.value : 'all';
  var list = document.getElementById('historyList');
  var stats = document.getElementById('historyStats');
  list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gray-400);">Loading...</div>';
  try{
    var rows = await api('/history/all');
    if(!Array.isArray(rows)||!rows.length){
      list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--gray-400);">No records yet.</div>';
      return;
    }
    // Filter
    var filtered = rows.filter(function(r){
      if(filterVal==='urgent') return r.urgency_score>=9;
      if(filterVal==='escalated') return r.clinical_routing_level&&r.clinical_routing_level!=='none';
      if(filterVal==='corrected') return r.actual_response_sent;
      if(filterVal==='unvalidated') return r.clinical_routing_level&&r.clinical_routing_level!=='none'&&!r.escalation_validated;
      return true;
    });
    // Stats
    var total=rows.length, urgent=rows.filter(function(r){return r.urgency_score>=9;}).length;
    var escalated=rows.filter(function(r){return r.clinical_routing_level&&r.clinical_routing_level!=='none';}).length;
    var corrected=rows.filter(function(r){return r.actual_response_sent;}).length;
    var wrongEsc=rows.filter(function(r){return r.escalation_validated&&!r.escalation_correct;}).length;
    var avgScore=rows.reduce(function(a,r){return a+(r.urgency_score||0);},0)/Math.max(rows.length,1);
    stats.innerHTML=[
      {label:'Total Triages',val:total,color:'var(--blue)'},
      {label:'Avg Priority Score',val:avgScore.toFixed(1)+' / 10',color:'var(--gray-700)'},
      {label:'Escalated',val:escalated,color:'var(--amber)'},
      {label:'Flagged Incorrect',val:wrongEsc,color:'var(--red)'},
    ].map(function(s){
      return '<div style="background:var(--white);border:1.5px solid var(--gray-200);border-radius:12px;padding:16px 18px;">'+
        '<div style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);margin-bottom:6px;">'+s.label+'</div>'+
        '<div style="font-size:var(--fs-xl);font-weight:700;color:'+s.color+';">'+s.val+'</div>'+
      '</div>';
    }).join('');
    // Table
    list.innerHTML='<div style="background:var(--white);border:1.5px solid var(--gray-200);border-radius:12px;overflow:hidden;">'+
      '<table style="width:100%;border-collapse:collapse;font-size:var(--fs-xs);">'+
        '<thead><tr style="background:var(--gray-50);border-bottom:1px solid var(--gray-200);">'+
          '<th style="padding:10px 14px;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Date</th>'+
          '<th style="padding:10px 14px;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Staff</th>'+
          '<th style="padding:10px 14px;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Category</th>'+
          '<th style="padding:10px 14px;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Score</th>'+
          '<th style="padding:10px 14px;text-align:left;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Urgency</th>'+
          '<th style="padding:10px 14px;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Corrected</th>'+
          '<th style="padding:10px 14px;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">Esc. Valid</th>'+
        '</tr></thead>'+
        '<tbody>'+
        filtered.slice(0,100).map(function(r,i){
          var dt=new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
          var score=r.urgency_score||'-';
          var scoreColor=score>=9?'var(--red)':score>=6?'var(--amber)':'var(--green)';
          var urg=r.urgency_override||r.urgency_original||'-';
          var corrected=r.actual_response_sent?'&#10003;':'-';
          var escStatus=!r.escalation_validated?'-':r.escalation_correct?'<span style="color:var(--green)">&#10003;</span>':'<span style="color:var(--red)">&#10007;</span>';
          var bg=i%2===0?'var(--white)':'var(--gray-50)';
          return '<tr style="background:'+bg+';border-bottom:1px solid var(--gray-100);">'+
            '<td style="padding:9px 14px;color:var(--gray-600);">'+dt+'</td>'+
            '<td style="padding:9px 14px;color:var(--gray-700);font-weight:500;">'+esc(r.nurse_name||'')+'</td>'+
            '<td style="padding:9px 14px;color:var(--gray-800);">'+esc(r.clinical_category||'')+'</td>'+
            '<td style="padding:9px 14px;text-align:center;font-weight:700;color:'+scoreColor+';">'+score+'</td>'+
            '<td style="padding:9px 14px;color:var(--gray-700);">'+esc(urg)+'</td>'+
            '<td style="padding:9px 14px;text-align:center;color:var(--green);">'+corrected+'</td>'+
            '<td style="padding:9px 14px;text-align:center;">'+escStatus+'</td>'+
          '</tr>';
        }).join('')+
        '</tbody>'+
      '</table>'+
    '</div>';
  }catch(e){
    list.innerHTML='<div style="color:var(--red);padding:20px;">Error: '+esc(e.message)+'</div>';
  }
}



function goToClarifications(){
  closeProfile();
  var histBtn = document.getElementById('historyTabBtn');
  if(histBtn) switchTab('history', histBtn);
}

async function saveReviewRequest(reviewRequest, patientMsg, aiDraft, triageId){
  try{
    await api('/reviews','POST',{
      action: 'create',
      triage_id: triageId,
      company_id: getCompanyId(),
      created_by: getUserId(),
      question: reviewRequest.question,
      context: reviewRequest.context || 'general',
      confidence: reviewRequest.confidence || null,
      patient_message: (patientMsg||'').substring(0,500),
      ai_draft: (aiDraft||'').substring(0,500)
    });
    // Refresh badge count
    loadReviews();
  }catch(e){}
}

async function loadReviews(){
  try{
    var rows = await api('/reviews');
    var pending = Array.isArray(rows) ? rows.filter(function(r){return r.status==='pending';}) : [];
    updateReviewBadge(pending.length);
    window._pendingReviews = pending;
    renderReviews(pending);
  }catch(e){}
}

function updateReviewBadge(count){
  var badge = document.getElementById('clarificationBadge');
  var profBadge = document.getElementById('profileBadgeCount');
  if(badge){
    badge.style.display = count > 0 ? 'flex' : 'none';
    badge.textContent = count > 9 ? '9+' : String(count);
  }
  if(profBadge) profBadge.textContent = count > 0 ? String(count) : '';
}

function renderReviews(pending){
  var list = document.getElementById('clarificationList');
  var countEl = document.getElementById('clarificationCount');
  if(!list) return;

  if(countEl){
    countEl.textContent = pending.length > 0 ? pending.length + ' pending' : '';
    countEl.style.display = pending.length > 0 ? '' : 'none';
  }

  list.innerHTML = '';

  if(!pending.length){
    list.innerHTML = '<div style="text-align:center;padding:32px 20px;color:var(--gray-400);font-size:var(--fs-sm);">No pending items. The AI is operating with high confidence.</div>';
    return;
  }

  var contextLabels = {routing:'Routing Decision',severity:'Severity Classification',category:'Category Assignment',kb_gap:'Knowledge Gap',protocol:'Protocol Question',general:'General Review'};

  pending.forEach(function(item){
    var conf = item.confidence ? Math.round(item.confidence * 100) + '%' : 'n/a';
    var confColor = item.confidence < 0.5 ? 'var(--red)' : item.confidence < 0.7 ? 'var(--amber)' : 'var(--green)';
    var label = contextLabels[item.context] || item.context || 'Review';
    var excerpt = item.patient_message ? item.patient_message.substring(0,120) + (item.patient_message.length > 120 ? '...' : '') : '';

    // Card
    var card = document.createElement('div');
    card.id = 'review-' + item.id;
    card.style.cssText = 'border:1.5px solid var(--gray-200);border-radius:12px;overflow:hidden;margin-bottom:12px;';

    // Header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'padding:12px 16px;background:var(--gray-50);border-bottom:1px solid var(--gray-100);display:flex;align-items:center;justify-content:space-between;gap:12px;';
    hdr.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' +
      '<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gray-500);">' + esc(label) + '</span>' +
      '<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:8px;background:var(--gray-100);color:' + confColor + ';">AI confidence: ' + conf + '</span>' +
      '</div>' +
      '<span style="font-size:11px;color:var(--gray-400);">' + new Date(item.created_at).toLocaleDateString() + '</span>';

    // Body
    var body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px;';

    var qDiv = document.createElement('div');
    qDiv.style.cssText = 'font-size:var(--fs-base);font-weight:600;color:var(--gray-800);margin-bottom:8px;line-height:1.5;';
    qDiv.textContent = item.question;
    body.appendChild(qDiv);

    if(excerpt){
      var exDiv = document.createElement('div');
      exDiv.style.cssText = 'font-size:var(--fs-xs);color:var(--gray-500);background:var(--gray-50);border-radius:7px;padding:8px 10px;margin-bottom:12px;line-height:1.5;font-style:italic;';
      exDiv.textContent = 'Patient: "' + excerpt + '"';
      body.appendChild(exDiv);
    }

    var ta = document.createElement('textarea');
    ta.id = 'ans-' + item.id;
    ta.style.cssText = 'width:100%;min-height:80px;padding:10px 12px;border:1.5px solid var(--gray-200);border-radius:8px;font-family:var(--sans);font-size:var(--fs-sm);resize:vertical;outline:none;color:var(--gray-800);';
    ta.placeholder = 'Your answer — be specific. This will be applied to the KB or used to improve routing logic.';
    body.appendChild(ta);

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;align-items:center;';

    var submitBtn = document.createElement('button');
    submitBtn.style.cssText = 'padding:8px 18px;background:var(--blue);border:none;border-radius:8px;color:white;font-family:var(--sans);font-size:var(--fs-sm);font-weight:600;cursor:pointer;';
    submitBtn.textContent = 'Submit Answer';
    (function(itemId, itemQ, itemCtx){
      submitBtn.addEventListener('click', function(){ submitReview(itemId, itemQ, itemCtx); });
    })(item.id, item.question, item.context || 'general');

    var dismissBtn = document.createElement('button');
    dismissBtn.style.cssText = 'padding:8px 14px;background:var(--white);border:1.5px solid var(--gray-200);border-radius:8px;color:var(--gray-500);font-family:var(--sans);font-size:var(--fs-sm);font-weight:500;cursor:pointer;';
    dismissBtn.textContent = 'Dismiss';
    (function(itemId){ dismissBtn.addEventListener('click', function(){ dismissReview(itemId); }); })(item.id);

    var statusSpan = document.createElement('span');
    statusSpan.id = 'review-status-' + item.id;
    statusSpan.style.cssText = 'font-size:var(--fs-xs);color:var(--gray-500);flex:1;';

    btnRow.appendChild(submitBtn);
    btnRow.appendChild(dismissBtn);
    btnRow.appendChild(statusSpan);
    body.appendChild(btnRow);

    card.appendChild(hdr);
    card.appendChild(body);
    list.appendChild(card);
  });
}


async function submitReview(id, question, context){
  var ansEl = document.getElementById('ans-'+id);
  var statusEl = document.getElementById('review-status-'+id);
  if(!ansEl || !ansEl.value.trim()){
    if(statusEl) statusEl.textContent = 'Please enter an answer.';
    return;
  }
  if(statusEl){ statusEl.textContent = 'Saving and applying...'; statusEl.style.color='var(--gray-400)'; }

  try{
    var result = await api('/reviews','POST',{
      action: 'resolve',
      id: id,
      question: question,
      context: context,
      answer: ansEl.value.trim(),
      resolved_by: getUserId(),
      resolved_by_name: window.currentNurse || 'Admin'
    });

    var appliedTo = result.applied_to || 'confirmation';
    var msg = appliedTo==='kb' ? '✓ Answer added to Knowledge Base' :
              appliedTo==='correction' ? '✓ Saved as correction' :
              '✓ Saved — confirms existing logic';

    if(statusEl){ statusEl.textContent = msg; statusEl.style.color='var(--green)'; }

    // Remove from list after short delay
    setTimeout(function(){
      var card = document.getElementById('review-'+id);
      if(card){ card.style.opacity='0'; card.style.transition='opacity .3s'; }
      setTimeout(function(){
        loadReviews();
        // If answer went to KB, refresh the KB if open
        if(appliedTo==='kb') invalidateKBCache();
      }, 300);
    }, 1500);

  }catch(e){
    if(statusEl){ statusEl.textContent = 'Error: '+e.message; statusEl.style.color='var(--red)'; }
  }
}

async function dismissReview(id){
  try{
    await api('/reviews','POST',{ action:'dismiss', id:id });
    var card = document.getElementById('review-'+id);
    if(card){ card.style.opacity='0'; card.style.transition='opacity .3s'; }
    setTimeout(function(){ loadReviews(); }, 300);
  }catch(e){}
}


function showToast(msg,type){
  var t=document.getElementById('saveToast');
  t.textContent=msg;
  t.style.background=type==='error'?'var(--red)':type==='warn'?'var(--amber)':'var(--green)';
  t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},2800);
}

function esc(str){
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

initAuth();
// KB loads on demand when tab is opened -- not on page init
// This prevents null-reference errors from KB DOM elements not being present
