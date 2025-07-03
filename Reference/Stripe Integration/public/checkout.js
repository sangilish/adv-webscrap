// This is your test secret API key.
const stripe = Stripe("pk_test_51RgR7aD6TknMMBFoNVwk0m200DsM72tXY5tgGv0U5sfnnHNfwCN2PJzkvtN6mPLqHP4HdMIddgxilRGkQ5qXAsbP00KOIa5gPN");

initialize();

// Create a Checkout Session
async function initialize() {
  const fetchClientSecret = async () => {
    const response = await fetch("/create-checkout-session", {
      method: "POST",
    });
    const { clientSecret } = await response.json();
    return clientSecret;
  };

  const checkout = await stripe.initEmbeddedCheckout({
    fetchClientSecret,
  });

  // Mount Checkout
  checkout.mount('#checkout');
}