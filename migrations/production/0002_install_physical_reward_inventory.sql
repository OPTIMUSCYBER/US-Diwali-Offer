-- PRODUCTION INVENTORY INSTALLATION — run only after production/0001 is recorded.
-- INSERT OR IGNORE makes a retried statement non-destructive: it never resets a
-- remaining quantity. The postflight must confirm all eleven expected rows and 216
-- finite initial units before the Worker is deployed.

INSERT OR IGNORE INTO reward_inventory
  (reward_id, reward_name, initial_quantity, remaining_quantity, unit_value_paise, is_fallback)
VALUES
 ('SUPER_YOU_PROTEIN','Super You Protein – 1 kg',1,1,220000,0),
 ('PSYCHO_PUMP','One Science Psycho Pump – 15 servings',1,1,70000,0),
 ('PROTEIN_SAMPLE_BOX','One Science Protein Sample Box',1,1,70000,0),
 ('REGULAR_SHAKER','Shaker',1,1,7000,0),
 ('TSHIRT','T-shirt',1,1,10000,0),
 ('STEEL_SHAKER','Steel Shaker',1,1,35000,0),
 ('MUSCLE_SCIENCE_PREWORKOUT','Muscle Science Pre-workout – 2-serving pack',100,100,5000,0),
 ('BIG_FLEX_BCAA','Big Flex BCAA',10,10,NULL,0),
 ('PINTOLA_OATS','Pintola Oats – 1 serving',50,50,NULL,0),
 ('KEYCHAIN','Keychain',50,50,NULL,0),
 ('BETTER_LUCK','Better Luck Next Time',NULL,NULL,0,1);
