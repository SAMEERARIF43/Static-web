const axios = require("axios");
axios.post("https://graphql.anilist.co", {
  query: `query {
    __type(name: "RecommendationSort") {
      enumValues { name }
    }
  }`
}).then(r => console.log(JSON.stringify(r.data, null, 2))).catch(e => console.error(e.response?.data || e.message));
