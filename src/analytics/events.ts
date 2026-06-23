// Shared analytics event contract — server-side mirror of the frontend's
// `app/analytics/events.ts` AnalyticsEvent union. Property names are snake_case
// and carry NO PII (users are user.id, decks are deck_id).
//
// Keep this byte-compatible with the FE union by hand until we pick a
// distribution mechanism (private npm pkg vs git submodule). Reconstructed from
// the analytics brief; reconcile against the real FE file when it's shared.

export type BillingPlan = 'monthly' | 'annual';

/**
 * Discriminated union of every event the BACKEND is responsible for. The client
 * fires UI/funnel events separately; these are the ones that can only be emitted
 * reliably server-side (revenue, account creation, cap hits, milestones).
 */
export type AnalyticsEvent =
    | { name: 'account_created'; props: { method: 'email' | 'google' } }
    | {
          name: 'first_value_reached';
          props: { milestone: 'first_deck' | 'first_session' | 'first_review' };
      }
    | {
          name: 'ai_cap_reached';
          props: {
              ai_feature: 'generate_deck' | 'enrich_words' | 'suggestion';
              cap_per_day: number;
          };
      }
    | {
          name: 'subscription_started';
          props: { billing_plan: BillingPlan; status: 'trialing' | 'active'; price: number };
      }
    | { name: 'trial_started'; props: { billing_plan: BillingPlan } }
    | { name: 'trial_converted'; props: { billing_plan: BillingPlan; price: number } }
    | { name: 'subscription_renewed'; props: { billing_plan: BillingPlan; price: number } }
    | {
          name: 'subscription_canceled';
          props: { billing_plan: BillingPlan; reason?: string };
      };

export type AnalyticsEventName = AnalyticsEvent['name'];

/** Extract the props type for a given event name. */
export type PropsFor<N extends AnalyticsEventName> = Extract<AnalyticsEvent, { name: N }>['props'];

/**
 * Allowlisted Mixpanel people-profile properties. The backend only sets the
 * props it authoritatively owns (`plan`, `is_ever_paid`, `signup_date`); the
 * rest are set by the client on identify.
 */
export type UserProps = {
    plan: 'free' | 'premium';
    signup_date: string;
    acquisition_source: string;
    native_language: string;
    learning_language: string;
    daily_goal_tier: string;
    lifetime_decks_created: number;
    current_streak: number;
    is_ever_paid: boolean;
};
