import { expect } from 'chai';
import { describe, it } from 'mocha';
import sinon from 'sinon';
import * as stripe from '../server/paymentProviders/stripe/gateway';
import Promise from 'bluebird';
import * as utils from './utils';
import models from '../server/models';


describe('graphql.tiers.test', () => {
  let user1, user2, host, collective1, collective2, tier1, paymentMethod1;
  let sandbox;

  beforeEach(() => utils.resetTestDB());

  /**
   * Setup:
   * - User1 is a member of collective2 has a payment method on file
   * - User1 will become a backer of collective1
   * - Host is the host of both collective1 and collective2
   */
  beforeEach(() => models.User.createUserWithCollective(utils.data('user1')).tap(u => user1 = u));
  beforeEach(() => models.User.createUserWithCollective(utils.data('user2')).tap(u => user2 = u));
  beforeEach(() => models.User.createUserWithCollective(utils.data('host1')).tap(u => host = u));
  beforeEach(() => models.PaymentMethod.create({
    ...utils.data('paymentMethod2'), 
    CreatedByUserId: user1.id,
    CollectiveId: user1.CollectiveId
  }).tap(c => paymentMethod1 = c));

  beforeEach(() => models.Collective.create(utils.data('collective1')).tap(g => collective1 = g));

  beforeEach(() => models.Collective.create(utils.data('collective2')).tap(g => collective2 = g));

  beforeEach(() => collective1.createTier(utils.data('tier1')).tap(t => tier1 = t));

  beforeEach(() => collective1.addHost(host.collective));
  beforeEach(() => collective2.addHost(host.collective));
  beforeEach(() => collective2.addUserWithRole(user1, 'ADMIN'));

  beforeEach('create stripe account', (done) => {
    models.ConnectedAccount.create({
      service: 'stripe',
      CollectiveId: host.collective.id,
      token: 'abc'
    })
    .tap(() => done())
    .catch(done);
  });

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  after(() => sandbox.restore());

  before(() => {
    sandbox.stub(stripe, 'createToken', () => {
      return Promise.resolve({ id: 'tok_B5s4wkqxtUtNyM'});
    });
    sandbox.stub(stripe, 'createCustomer', () => {
      return Promise.resolve({ id: 'cus_B5s4wkqxtUtNyM'});
    });
    sandbox.stub(stripe, 'createCharge', (hostStripeAccount, data) => {
      return Promise.resolve({
        "amount": data.amount,
        "balance_transaction": "txn_19XJJ02eZvKYlo2ClwuJ1rbA",
      });
    });
    sandbox.stub(stripe, 'retrieveBalanceTransaction', () => {
      return Promise.resolve({
        "id": "txn_19XJJ02eZvKYlo2ClwuJ1rbA",
        "object": "balance_transaction",
        "amount": 999,
        "available_on": 1483920000,
        "created": 1483315442,
        "currency": "usd",
        "description": null,
        "fee": 59,
        "fee_details": [
          {
            "amount": 59,
            "application": null,
            "currency": "usd",
            "description": "Stripe processing fees",
            "type": "stripe_fee"
          }
        ],
        "net": 940,
        "source": "ch_19XJJ02eZvKYlo2CHfSUsSpl",
        "status": "pending",
        "type": "charge"
      });
    });
    sandbox.stub(stripe, 'getOrCreatePlan', () => {
      return Promise.resolve({ id: 'stripePlanId-111' });
    });
    sandbox.stub(stripe, 'createSubscription', () => {
      return Promise.resolve({ id: 'stripeSubscriptionId-123' });
    });

    
  });

  describe('graphql.tiers.test.js', () => {

    describe('fetch tiers of a collective', () => {
      beforeEach(() => collective1.createTier({ slug: 'bronze-sponsor', name: 'bronze sponsor'}));
      beforeEach(() => collective1.createTier({ slug: 'gold-sponsor', name: 'gold sponsor'}));

      const getTiersQuery = `
      query Collective($collectiveSlug: String!, $tierSlug: String, $tierId: Int) {
        Collective(slug: $collectiveSlug) {
          tiers(slug: $tierSlug, id: $tierId) {
            id
            name
          }
        }
      }`;

      it("fetch all tiers", async () => {
        const res = await utils.graphqlQuery(getTiersQuery, { collectiveSlug: collective1.slug});
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(3);
      });

      it("filter tiers by slug", async () => {
        const res = await utils.graphqlQuery(getTiersQuery, { collectiveSlug: collective1.slug, tierSlug: 'bronze-sponsor'});
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(1);
        expect(tiers[0].name).to.equal('bronze sponsor');
      });

      it("filter tiers by tierId", async () => {
        const res = await utils.graphqlQuery(getTiersQuery, { collectiveSlug: collective1.slug, tierId: 1});
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(1);
        expect(tiers[0].id).to.equal(1);
      });
    })

    describe('payment methods', () => {

      const createOrderQuery = `
      mutation createOrder($order: OrderInputType!) {
        createOrder(order: $order) {
          createdByUser {
            id,
            email
          },
          paymentMethod {
            data,
            name
          }
        }
      }`;
      

      const generateOrder = (user) => {
        return {
          description: "test order",
          user: {
            email: user.email,
          },
          collective: { id: collective1.id },
          tier: { id: tier1.id },
          paymentMethod: {
            service: 'stripe',
            name: '4242',
            token: 'tok_123456781234567812345678',
            data: {
              expMonth: 1,
              expYear: 2021,
              funding: 'credit',
              brand: 'Visa',
              country: 'US',
            }
          }
        }
      }

      it("fails to use a payment method on file if not logged in", async () => {
        const order = generateOrder(user1);
        order.paymentMethod = { uuid: paymentMethod1.uuid, service: 'stripe' };

        const result = await utils.graphqlQuery(createOrderQuery, { order });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal("You need to be logged in to be able to use a payment method on file");
      });
    
      it("fails to use a payment method on file if not logged in as the owner", async () => {
        const order = generateOrder(user1);
        order.paymentMethod = { uuid: paymentMethod1.uuid };

        const result = await utils.graphqlQuery(createOrderQuery, { order }, user2);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal("You don't have sufficient permissions to access this payment method");
      });
          
      it("user1 becomes a backer of collective1 using a payment method on file", async () => {
        const orderInput = generateOrder(user1);
        orderInput.paymentMethod = { uuid: paymentMethod1.uuid };

        const result = await utils.graphqlQuery(createOrderQuery, { order: orderInput }, user1);
        result.errors && console.error(result.errors[0]);
        expect(result.errors).to.not.exist;

        const members = await models.Member.findAll({where: { MemberCollectiveId: user1.CollectiveId, CollectiveId: collective1.id }});
        const orders = await models.Order.findAll({where: { FromCollectiveId: user1.CollectiveId, CollectiveId: collective1.id }});
        // const subscription = await models.Subscription.findById(orders[0].SubscriptionId);
        const order = await models.Order.findById(orders[0].id);
        const transactions = await models.Transaction.findAll({where: { FromCollectiveId: user1.CollectiveId, CollectiveId: collective1.id }});

        expect(members).to.have.length(1);
        expect(orders).to.have.length(1);
        // TODO: Fix this when we fix Tiers
        // Currently, createOrder mutation overrides tier.interval with order.interval
        // expect(orders[0].SubscriptionId).to.not.be.null;
        // expect(subscription.interval).to.equal(tier1.interval);
        expect(transactions).to.have.length(1);
        expect(transactions[0].amount).to.equal(tier1.amount);
        expect(order.processedAt).to.not.be.null;
      });
      
      it("user1 becomes a backer of collective1 using a new payment method", async () => {
        const result = await utils.graphqlQuery(createOrderQuery, { order: generateOrder(user1) });
        result.errors && console.error(result.errors[0]);
        expect(result.errors).to.not.exist;
        const members = await models.Member.findAll({where: { MemberCollectiveId: user1.CollectiveId, CollectiveId: collective1.id }});
        expect(members).to.have.length(1);
        const paymentMethods = await models.PaymentMethod.findAll({where: { CreatedByUserId: user1.id }});
        expect(paymentMethods).to.have.length(2);
      });
    });
  });
});