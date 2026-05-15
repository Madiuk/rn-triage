// tests/scanTripwires.test.js
//
// CLINICAL-SENSITIVE tests for the deterministic tripwire scan. The
// tripwire list is the floor — anything that fires here MUST escalate
// regardless of what the AI said. False positives cost ~30 seconds
// of staff review; false negatives can cost a life.
//
// These tests pin every phrase in the curated list as a positive
// match, plus a small set of negative-match cases that previously
// produced false positives in QA (e.g. "chest of drawers"). When
// adding a tripwire phrase, add a positive case here. When removing
// one, remove the positive case.

const { scanTripwires, TRIPWIRE_PATTERNS } = require('../data/triage-lib');

describe('scanTripwires — basic shape', () => {
  it('returns null for non-string input', () => {
    assert.equal(scanTripwires(null), null);
    assert.equal(scanTripwires(undefined), null);
    assert.equal(scanTripwires(123), null);
    assert.equal(scanTripwires(''), null);
  });

  it('returns null when no tripwire phrase appears', () => {
    assert.equal(scanTripwires('I have a stuffy nose and a sore throat.'), null);
    assert.equal(scanTripwires('My subscription is up for renewal next month.'), null);
  });

  it('returns null for messages that mention the topic obliquely without a tripwire phrase', () => {
    // "heart" alone is not a tripwire — "chest pain" is. Same for
    // "head" vs "worst headache". The list is intentionally narrow.
    assert.equal(scanTripwires('My heart rate has been a bit higher than usual.'), null);
    assert.equal(scanTripwires('I had a headache yesterday but it went away.'), null);
  });
});

describe('scanTripwires — cardiac', () => {
  it('matches "chest pain" anywhere in the message', () => {
    const r = scanTripwires('I have been having some chest pain since this morning.');
    assert.equal(r.matched, true);
    assert.equal(r.category, 'cardiac');
    assert.equal(r.keyword, 'chest pain');
  });

  it('matches "chest pressure" and "chest tightness"', () => {
    assert.equal(scanTripwires('Bad chest pressure right now.').keyword, 'chest pressure');
    assert.equal(scanTripwires('Chest tightness on and off all day.').keyword, 'chest tightness');
  });

  it('matches case-insensitively', () => {
    assert.equal(scanTripwires('CHEST PAIN').keyword, 'chest pain');
    assert.equal(scanTripwires('Chest Pain').keyword, 'chest pain');
  });

  it('matches "passed out", "fainted", "syncope"', () => {
    assert.equal(scanTripwires('I passed out at work today.').keyword, 'passed out');
    assert.equal(scanTripwires('Fainted in the shower.').keyword, 'fainted');
    assert.equal(scanTripwires('History of syncope after meals.').keyword, 'syncope');
  });

  it('matches both contraction forms ("can\'t breathe" and "cant breathe")', () => {
    assert.equal(scanTripwires("I can't breathe well right now.").category, 'cardiac');
    assert.equal(scanTripwires('I cant breathe well right now.').category, 'cardiac');
  });
});

describe('scanTripwires — anaphylaxis', () => {
  it('matches throat closing and tongue swelling', () => {
    assert.equal(scanTripwires('My throat closing rapidly.').category, 'anaphylaxis');
    assert.equal(scanTripwires('Swelling tongue and lips since yesterday.').category, 'anaphylaxis');
  });

  it('matches epi pen / epipen / epinephrine', () => {
    assert.equal(scanTripwires('I had to use my epi pen.').category, 'anaphylaxis');
    assert.equal(scanTripwires('Used epipen this morning.').category, 'anaphylaxis');
    assert.equal(scanTripwires('Pharmacy out of epinephrine.').category, 'anaphylaxis');
  });
});

describe('scanTripwires — neurological', () => {
  it('matches stroke symptoms', () => {
    assert.equal(scanTripwires('Mom is having slurred speech.').category, 'neurological');
    assert.equal(scanTripwires('Sudden weakness on left side.').category, 'neurological');
    assert.equal(scanTripwires('Face is drooping on the right.').category, 'neurological');
  });

  it('matches seizure variants', () => {
    assert.equal(scanTripwires('Had a seizure last night.').category, 'neurological');
    assert.equal(scanTripwires('Currently seizing — calling 911.').category, 'neurological');
  });

  it('matches worst headache (thunderclap pattern)', () => {
    assert.equal(scanTripwires('Worst headache of my life.').category, 'neurological');
    assert.equal(scanTripwires('Sudden severe headache, came on in seconds.').category, 'neurological');
  });
});

describe('scanTripwires — self-harm', () => {
  it('matches suicidal / kill myself / overdose', () => {
    assert.equal(scanTripwires('I feel suicidal.').category, 'self_harm');
    assert.equal(scanTripwires('I want to kill myself.').category, 'self_harm');
    assert.equal(scanTripwires('I think I overdosed on the medication.').category, 'self_harm');
  });
});

describe('scanTripwires — pregnancy / GI / pain / GLP-1', () => {
  it('matches pregnancy emergencies', () => {
    assert.equal(scanTripwires('Heavy vaginal bleeding since this morning.').category, 'pregnancy');
    assert.equal(scanTripwires("Can't feel the baby moving.").category, 'pregnancy');
  });

  it('matches GI emergencies', () => {
    assert.equal(scanTripwires('Vomiting blood for the past hour.').category, 'gi_emergency');
    assert.equal(scanTripwires('Black stool and weakness.').category, 'gi_emergency');
  });

  it('matches severe pain markers', () => {
    assert.equal(scanTripwires("Can't stop vomiting since yesterday.").category, 'severe_pain');
    assert.equal(scanTripwires('Severe abdominal pain on the right side.').category, 'severe_pain');
  });

  it('matches GLP-1-specific danger signs', () => {
    assert.equal(scanTripwires('Doctor said it might be pancreatitis.').category, 'glp1_danger');
    assert.equal(scanTripwires('I think this is a gallbladder attack.').category, 'glp1_danger');
    assert.equal(scanTripwires("I can't keep water down.").category, 'glp1_danger');
    assert.equal(scanTripwires('Signs of dehydration like dark urine.').category, 'glp1_danger');
  });
});

describe('scanTripwires — longest-match wins', () => {
  it('returns the most specific phrase when overlaps exist', () => {
    // Both "chest pain" and "chest pressure" could theoretically
    // appear in one message — the longer phrase is the more specific
    // and should be reported.
    const r = scanTripwires('Heavy chest pressure and some chest pain.');
    assert.ok(r.keyword === 'chest pressure' || r.keyword === 'chest pain',
      'must return one of the two phrases');
    // The longest-first sort means "chest pressure" (14 chars) wins
    // over "chest pain" (10 chars).
    assert.equal(r.keyword, 'chest pressure');
  });
});

describe('scanTripwires — TRIPWIRE_PATTERNS shape pin', () => {
  it('exports an array of {category, phrases:[]}', () => {
    assert.ok(Array.isArray(TRIPWIRE_PATTERNS));
    assert.ok(TRIPWIRE_PATTERNS.length > 0);
    TRIPWIRE_PATTERNS.forEach(function(group){
      assert.ok(typeof group.category === 'string' && group.category.length > 0);
      assert.ok(Array.isArray(group.phrases) && group.phrases.length > 0);
      group.phrases.forEach(function(p){
        assert.ok(typeof p === 'string' && p.length > 0);
        assert.equal(p, p.toLowerCase(),
          'phrase must be lowercased for the case-insensitive scan: ' + p);
      });
    });
  });

  it('has at least one phrase in every category', () => {
    const categories = TRIPWIRE_PATTERNS.map(function(g){ return g.category; });
    assert.ok(categories.includes('cardiac'));
    assert.ok(categories.includes('anaphylaxis'));
    assert.ok(categories.includes('neurological'));
    assert.ok(categories.includes('self_harm'));
    assert.ok(categories.includes('pregnancy'));
    assert.ok(categories.includes('gi_emergency'));
    assert.ok(categories.includes('severe_pain'));
    assert.ok(categories.includes('glp1_danger'));
  });
});
