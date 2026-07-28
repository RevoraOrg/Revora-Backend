#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env, Vec};

    fn create_basic_vesting(env: &Env, beneficiary: &Address) {
        VestingContract::create_vesting(
            env.clone(),
            beneficiary.clone(),
            1000,
            1000,
            2000,
            3000,
        );
    }

    #[test]
    fn test_create_vesting() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let total_amount = 1000i128;
        let start_time = 1000u64;
        let cliff_time = 2000u64;
        let end_time = 3000u64;

        VestingContract::create_vesting(
            env.clone(),
            beneficiary.clone(),
            total_amount,
            start_time,
            cliff_time,
            end_time,
        );

        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&StorageKey::Vesting(beneficiary))
            .unwrap();
        assert_eq!(schedule.total_amount, total_amount);
        assert_eq!(schedule.start_time, start_time);
        assert_eq!(schedule.cliff_time, cliff_time);
        assert_eq!(schedule.end_time, end_time);
        assert_eq!(schedule.claimed, 0);
    }

    #[test]
    fn test_partial_claim_tracks_cursor_and_ledger() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        create_basic_vesting(&env, &beneficiary);

        env.ledger().set_timestamp(2500);

        VestingContract::claim(env.clone(), beneficiary.clone(), 250);

        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&StorageKey::Vesting(beneficiary.clone()))
            .unwrap();
        assert_eq!(schedule.claimed, 250);

        let claims: Vec<PartialClaim> = env
            .storage()
            .persistent()
            .get(&StorageKey::Claims(beneficiary.clone()))
            .unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims.get(0).unwrap().amount, 250);
        assert_eq!(claims.get(0).unwrap().total_claimed, 250);

        env.ledger().set_timestamp(2750);
        VestingContract::claim(env.clone(), beneficiary.clone(), 125);

        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&StorageKey::Vesting(beneficiary.clone()))
            .unwrap();
        assert_eq!(schedule.claimed, 375);

        let claims: Vec<PartialClaim> = env
            .storage()
            .persistent()
            .get(&StorageKey::Claims(beneficiary))
            .unwrap();
        assert_eq!(claims.len(), 2);
        assert_eq!(claims.get(1).unwrap().amount, 125);
        assert_eq!(claims.get(1).unwrap().total_claimed, 375);
        assert_eq!(VestingContract::sum_claims(&claims), schedule.claimed);
    }

    #[test]
    #[should_panic(expected = "Claim amount exceeds vested amount")]
    fn test_claim_more_than_vested() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let total_amount = 1000i128;
        let start_time = 1000u64;
        let cliff_time = 2000u64;
        let end_time = 3000u64;

        VestingContract::create_vesting(
            env.clone(),
            beneficiary.clone(),
            total_amount,
            start_time,
            cliff_time,
            end_time,
        );

        env.ledger().set_timestamp(2500);

        VestingContract::claim(env.clone(), beneficiary.clone(), 600);
    }

    #[test]
    #[should_panic(expected = "Claim amount must be positive")]
    fn test_negative_claim() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let total_amount = 1000i128;
        let start_time = 1000u64;
        let cliff_time = 2000u64;
        let end_time = 3000u64;

        VestingContract::create_vesting(
            env.clone(),
            beneficiary.clone(),
            total_amount,
            start_time,
            cliff_time,
            end_time,
        );

        env.ledger().set_timestamp(2500);

        VestingContract::claim(env.clone(), beneficiary.clone(), -100);
    }

    #[test]
    #[should_panic(expected = "Claim amount exceeds vested amount")]
    fn test_claim_before_cliff_rejected() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        create_basic_vesting(&env, &beneficiary);

        env.ledger().set_timestamp(1500);
        VestingContract::claim(env.clone(), beneficiary, 1);
    }

    #[test]
    fn test_zero_duration_cliff_vests_at_end() {
        let schedule = VestingSchedule {
            total_amount: 1000,
            start_time: 1000,
            cliff_time: 2000,
            end_time: 2000,
            claimed: 0,
        };

        assert_eq!(VestingContract::calculate_vested(&schedule, 1999), 0);
        assert_eq!(VestingContract::calculate_vested(&schedule, 2000), 1000);
        assert_eq!(VestingContract::calculate_vested(&schedule, 2500), 1000);
    }

    #[test]
    #[should_panic(expected = "Claim ledger and schedule cursor are inconsistent")]
    fn test_claim_rejects_inconsistent_ledger() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let schedule = VestingSchedule {
            total_amount: 1000,
            start_time: 1000,
            cliff_time: 2000,
            end_time: 3000,
            claimed: 250,
        };
        env.storage()
            .persistent()
            .set(&StorageKey::Vesting(beneficiary.clone()), &schedule);

        let mut claims = Vec::new(&env);
        claims.push_back(PartialClaim {
            amount: 200,
            timestamp: 2500,
            total_claimed: 200,
        });
        env.storage()
            .persistent()
            .set(&StorageKey::Claims(beneficiary.clone()), &claims);

        env.ledger().set_timestamp(2600);
        VestingContract::claim(env.clone(), beneficiary, 1);
    }

    #[test]
    #[should_panic(expected = "Claim cursor exceeds total vesting amount")]
    fn test_claim_rejects_cursor_past_total_amount() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let schedule = VestingSchedule {
            total_amount: 1000,
            start_time: 1000,
            cliff_time: 2000,
            end_time: 3000,
            claimed: 1200,
        };
        env.storage()
            .persistent()
            .set(&StorageKey::Vesting(beneficiary.clone()), &schedule);

        env.ledger().set_timestamp(2600);
        VestingContract::claim(env.clone(), beneficiary, 1);
    }

    #[test]
    #[should_panic(expected = "Vested amount calculation overflowed")]
    fn test_claim_rejects_vested_overflow() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        let schedule = VestingSchedule {
            total_amount: (i128::MAX / 2) + 1,
            start_time: 0,
            cliff_time: 0,
            end_time: 3,
            claimed: 0,
        };
        env.storage()
            .persistent()
            .set(&StorageKey::Vesting(beneficiary.clone()), &schedule);

        env.ledger().set_timestamp(2);
        VestingContract::claim(env.clone(), beneficiary, 1);
    }

    #[test]
    #[should_panic(expected = "Total amount must be positive")]
    fn test_zero_total_rejected() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);

        let beneficiary = Address::random(&env);
        VestingContract::create_vesting(env, beneficiary, 0, 1000, 2000, 3000);
    }

    #[test]
    #[should_panic(expected = "Vesting schedule already exists")]
    fn test_duplicate_vesting_rejected() {
        let env = Env::default();
        let contract_id = Address::random(&env);
        env.register_contract(&contract_id, VestingContract);

        let admin = Address::random(&env);
        VestingContract::initialize(env.clone(), admin);
        env.mock_all_auths();

        let beneficiary = Address::random(&env);
        create_basic_vesting(&env, &beneficiary);
        VestingContract::create_vesting(env, beneficiary, 1000, 1000, 2000, 3000);
    }
}
