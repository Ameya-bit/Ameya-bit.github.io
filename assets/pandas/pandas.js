// Roaming pandas for the home-page hero. Base sprite + collision engine are a
// faithful reproduction of "panda collision" by masahito (ma5a):
// codepen.io/Ma5a/pen/WNEBqPO (MIT). Sprite path data reproduced verbatim under
// that licence, with thanks. The straw hat (dǒulì) and its 3-D per-direction
// drawings are ours, finalized in design/sketches/panda-behaviors-workshop.html.
// Ten pandas wander the hero, one wearing the hat; they stay above the Writing
// cue because the stage is clipped to the hero region. Respects reduced motion.
// Phase 1 (entrance): the stage starts empty — the hat panda ambles in first,
// alone, then the troupe walks on from the edges a couple at a time. See
// design/panda-choreography.md for the full multi-phase plan.
(() => {
  'use strict';
  const stage = document.getElementById('panda-stage');
  if (!stage) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = n => Math.ceil(Math.random() * n);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const variant = 'drop';                 // the calm hat-drop skit (no big launch)
  const PANDA_COUNT = 10;                  // ten pandas total, one of them hatted

  // ---- the hero card is an obstacle: pandas walk around it, never behind ----
  // FORBID is the fenced .hero-inner rectangle in stage-local pixels; a panda's
  // ~50px body (its 100px wrapper minus FOOT on each side) may not enter it.
  const FOOT = 24, GAP = 12;              // body inset, and breathing room round the fence
  let FORBID = null;
  function computeForbid() {
    const card = document.querySelector('.hero-inner');
    if (!card) { FORBID = null; return; }
    const c = card.getBoundingClientRect(), s = stage.getBoundingClientRect();
    FORBID = { l: c.left - s.left - GAP, t: c.top - s.top - GAP,
               r: c.right - s.left + GAP, b: c.bottom - s.top + GAP };
  }
  const inForbid = (x, y) => {
    if (!FORBID) return false;
    return x + 100 - FOOT > FORBID.l && x + FOOT < FORBID.r &&
           y + 100 - FOOT > FORBID.t && y + FOOT < FORBID.b;
  };

  // ---- sprite data + decoder from "panda collision" by ma5a (MIT, via CodePen) ----
  const pandaSvg = {
    up: 'd 601 9aAaAaAnBkNnUaNaN"/D 18 10bAaAnAnBuXaN"/F 22 10W7AaAaBaEaGiAW-6NiNnXaNbUaNaNaN"/D 30 10bAaEuUnU"/D 114 10bAaAnAnBuXaN"/F 117 10W7AaAaBaBaAaGkAn0NkNnKaNaNaUaNaU"/D 125 10eAaGnAnUnUnU"/D 66 12eBnAnAnNnUaN"/F 70 12W6AaAaAbEaGkAn2NuKaNaUaNaNaNaN"/D 76 12gEuNnNnN"/D 593 12eBnAnAuKaN"/F 596 12eAaAeUbAnEbKeAnAbJnAiAxNxAkAnUaXnNbNaNaU"/D 604 13bEuK"/D 166 14eEnAkKaN"/D 608 14aAnN"/F 169 15eAeAaAaBaAaAnAnBn0NkNnNnKbNgNaU"/D 222 15aAbBaGxKnKaN"/D 175 16gEnAnUnNnN"/D 308 16aAaAaAaBuAnAnEaAaAaEnAuNnNuNnUnNaUbw-7bN"/D 314 16gAaGkNuX"/D 268 17eAaAaAaAaAaGnBnNuUuUaUiNaNaU"/D 501 17bAaAuAnAnKaN"/D 548 17eAnAnAnAnKaN"/F 552 17jEW-6AkNaNaNbN"/D 557 17gExK"/D 209 18bAaEeAaBnAuAeAW8NnNnKgGnBn1NkGaAuNnNnXaUnw-6aN"/F 216 18jAaEgAxEaAaAW-8NkNbNaUnNkUaAeK"/D 260 18eAaBnAuAnEaBnAnBeAaEnAkNnXnNnNnXaNbXaNaN"/D 364 18eAaBuNkNaN"/D 509 18bAaBnAaEnAeAaAaBnAaEnAxXaNuNuNW-8AnAuUaUaNbNW6AeKnNnUaN"/D 159 19bAaBaAaAeAa0UaNaNeGnAnAnAiNn3NnNnNnXaN"/F 213 19aAnN"/D 214 19bBkNaN"/D 356 19eAnAnAnAnBbNW9NeAaAbAaAaBaBnBkBxUnNaNeUaNnUuNW-9AkAnAnEaAeAaBnAkUkNnXaNaNaw-6aNaN"/D 460 19eAaBuAnNnK"/F 502 19W6BaAaEkNW-6AuAnUaUaNaNaN"/F 312 20gAgAnAnBnAaAaEaAaNaGuAkAW-7NuNnKaAbNaKnNnNnKaNaNbN"/F 358 20W8AbAaAkAW-9AuUaNaNaN"/D 403 20eBnBnNnK"/F 407 20jAbAaAaAaGnAkAW-8NnNnUaUaUaNaN"/D 412 20gEnNnNuN"/D 451 20gAnAnAnBnI"/F 455 20jBaAaEbNaNaGuAnAn1NnXaUaNaNaN"/D 551 20W6AeAaAaAaEnNuNuNW-9AuAnKaNaNeN"/F 557 20gAaBnNnNkN"/D 17 21jAW6NjAaAaBaw6nJnBnAxNnUnNaNbNaNaKnKnNnNW-8AuAnAnGaBbAaAbAnAuAuNnNnw-7nIaUaN"/D 113 21eAa0NeAaAaBaBnEuKnNuNW-7AuAnBnBnBaAaAeBnAnAxNnw-6nNnKaKaUaU"/F 263 21W8BnBbBnNuEbNaNbAaBnNuAnEaBnAW-9NaKnNkUaNaBeUnNnAnUnKaNbN"/D 320 21ew9uAnNnKnNnNaUaNaN"/F 511 21aAnN"/D 596 21gAgNjAbBaEaBnBnJnBuAuNnNnXaNbNbNbNnNnNnNnNkNW-8AuAuKaNeN"/D 65 22aAa2NeAaBaw6uUnUnNuNW-6AkAnAnAnBuw-6aUaN"/F 462 22bAuN"/D 462 23bAaAnAuK"/F 464 23aAnN"/F 512 23aEuNaU"/F 21 24W8AaAaEaEnAnAuAW-7NnNuUnXaNaNbN"/D 417 24aAaBaAnBnAiAW-9NuNnKaNaBaAaAW8NeNaX"/F 549 24W9AbAbAaBxAnBnAW-6NuNuUnKaNbN"/F 596 24W8AeAaAaAaAaAuAuAuAnExNuNuNnNnNnKnUbNbN"/F 71 25W6AbAaBaBaAnAnAnAkAiNkNnNnNnKaNaNaNeN"/F 119 25W7AbAaEaBnAuAnAkAxNkNnNnUaUaUaNbN"/D 265 25bAuN"/F 359 25W9AbBaAnBkAnAaBuAW-7NaUnNkNnKaNaNeN"/D 403 25aAnN"/D 449 25bGaAa1NaNbNaAbJnNuNW-6AW-8NnNnNnX"/D 269 26bAaAnAuK"/D 361 26bAuN"/D 365 26bAaAnAuK"/F 161 27a3AgGnBuAkAW-6NkNnNnXnNaN"/D 262 27aAaBkUaN"/D 357 27bAaBnAuUnNaN"/F 497 27aAnN"/F 211 28eAa1GnBnNnAkAxNkNnNaNnX"/F 500 28W8AbAbAnGkAW-6NuNnNnUnNbNaN"/D 592 28aEaAaAaAbEnAkNnNnw-8"/D 158 29eGaAuNuX"/D 272 29bAaAaAnAnAuNnKaN"/D 546 29aBbAbEnAuNnNnI"/D 559 29gJnAxNnUaUaN"/F 418 30aGuAkAW-8NuKW9NjN"/F 403 31aAnN"/F 460 31W6AbAuAuAxAiNuNnUW8N"/D 65 32aAaAaAeAnAnAuNuI"/D 81 32aGnBxNnUeNaNaN"/D 129 32aEnAnAxNnNeNaNbN"/D 177 32aw6uAuNnNnUeNbU"/F 275 32aAnN"/F 274 33aAnN"/D 222 34aBnAkUeN"/',
    dUp: 'd 17 9eAnAnBuKaN"/F 20 9jAgAnAnBaBgBaEnAnAn0NkNuNnIaNaNaUaNaN"/D 113 9eBnAnAuKaN"/D 29 10bAaAaBnBxUnUaNaN"/F 116 10W6AbAnBaBeAaBaEnAxAkNiNuNuNnUnNaUaUbNaNaN"/D 124 10gAaEnBxUnUaU"/F 166 10eAnBaAaAbNaAaAaAbAuBnAuAkAW-9NnIaUaUaNaNeN"/D 169 10eAaEnAuNnNnUaN"/D 213 10bAaEbEuNnUkKaN"/D 65 11eBnAnAuKaN"/F 68 12W7AnBaAaAgAaGnAuAW-9NxNuNnUaUaNaNaNaNaN"/D 75 12eAaGkNnNnUaN"/D 599 12bAaEaAaAnAnNnUnNuUaN"/D 159 13bBnBnNnUaN"/F 209 13eAeBaAbKbAbGnBnAuAkAxAkNuw-7aUaNaN"/F 216 13bAuN"/D 591 13bBnAnAnAnKaNaN"/D 220 14aAnN"/F 593 14jAbAaBaAaNaNaAaGW-6AW-9AnUnXaNaNaNaN"/D 205 15bBnEnNnKaN"/D 548 15eAnAuAnUaN"/F 550 16gAbBaAbJnNnNnNuNW-9UaNbNbN"/D 177 17bAaEnAnBnAnAn1AuAuAnAnKnNnNnXaNbBaAW9NeNbNaUbN"/D 223 17bAaGnAnAuAW-7AkAnAuAnUnUnNbAeNgNeNbNaUaNaN"/D 556 17eAaBkNnU"/D 501 19eAaAiNaN"/D 263 20bAaEiAnKaNbN"/D 444 20bAaBnAnAnNnKaN"/F 449 20eAnEgEbKaBeAbAaGnBnAuUuNnUkAW-7NuNnXaNaNaUbN"/D 452 20eAaBnAxKaN"/D 16 21bAeAa1AaAaJnw6nAxNaNaNuInNkNW-8BnNnXaUaN"/D 113 21aAbAjAeNgAeAaAaEnAW-6NuNuNxNkAkAnEuNnXaNaNaNaNaN"/D 268 21gAaGnJnBnAnAnUnUuNaNaNaNnUnNaUaN"/D 302 21gAbNgAaAaAaAaBaAaEnBnAxNuNnNnw-6nAnAuNnUnK"/F 499 21W8EeJxNbNaUuAnBuNuNW-7NaNaNaNaN"/D 507 21eAaAnAkK"/D 545 21W9AbAaAaAaBaEnAuNnNnNnNuNuNW-7UaNaN"/D 63 22bAgAW9NbAaAaBaw6nAnGnAnAkNnXaUeUnNnNnNiNW-6AnAnBaBaAaAbAnAkNnNnw-6nNnUaUaNaN"/F 456 22aBuNaN"/D 600 22W8AaBnAn4AuAuXaNW9N"/D 398 23bBnAnAuUaNaN"/D 405 23eAaExNnUaN"/F 222 24bAaw6nBnAnAnAn0NnNnUnKaNbNaNeNW7N"/F 261 24jAaBaAnAnAnAbBaEiAnBW-6NkUnXaEbKnUbNbXeN"/F 359 24eAbAew6aBnAnXnNnNuNuNxNaNbN"/D 362 24eAaAuNuN"/F 400 24gBaAgUaNaBeAuAuGnAnAuAW-6NuUnIaNaNaN"/D 411 24gGjAaEnAxNaKnBnBnAnAnAuAuAW-7NuNnNnKaBbAW6NbNaNaXbNbNkU"/D 455 24bEuK"/D 254 25gGuAuBaEuKnUaXaN"/F 307 25aw6aAaAuAnBeNaNnNbAgNaEnAnNuAuBW-8NuNnXaBbKnNaNaNaNnNbNaN"/D 507 25bBnAuUaN"/F 543 25W7AbAbAaAaAaAnBnAkAxNuNnNuNnIaN"/F 115 26eAgAbAbAbBuAuAuBiNnNuNuUnKaNeN"/F 165 26a2EaExAnAnEkAxNuNuUnUnUaNaNbNbN"/D 225 26eJnAnAuUaI"/D 299 26gAaAaAnAnAnAaEuUnUnNnKaN"/F 494 26aAnN"/D 495 26W7AbAbAgAaBaAbEnAkNnUuNnNuNW-9AnIaN"/F 594 26a1JkAnEiNkNnNuXbNbN"/F 16 27W8AeAaJbAnAnAW-6NkNnNnNnNnKaU"/F 65 27W6AjAaAaAaBkBnBW-6NnNuNnNnUnUaNaN"/F 352 27eAaAuAbNgAaAbAnEnBnNxAnAxNnUnIaNaNaN"/D 355 27jAbAbAaAaw7nAkNnKaKaNuNnNuNkN"/D 367 27gAaGuAuNnI"/F 415 27aAnN"/o 356 28bAuN"/D 348 29bAnJaBuNnUnNnUaNbN"/D 354 29bAuN"/F 416 29aEnBnAnAuNaNaNaUaU"/D 464 29aAbAaEnAiNaUaK"/o 258 30bAuN"/D 351 30bBuU"/D 445 30bAW7NeBaAbEnAW-7NuNuNnNnNnU"/D 14 31aAaAaAaAaBnAxNnKaK"/D 111 31aBbAbBxNnX"/D 257 31bAuN"/D 304 31bAuN"/D 357 31bEkUaN"/F 495 31W9AbAaAbExAxNxNuNnKaN"/D 542 31aAbAaAaAnAnAuNnI"/D 602 31eAaJnAkNnIaN"/D 126 32bGnBnAuAuNnKaUbNbN"/D 174 32gAaJnAxNnNnKaNaN"/D 260 32bAaBnAkKaN"/D 590 32bAaAeBnAkNnUnU"/D 308 33bAaAnAkUaN"/D 555 33bEnAkNuNaNeN"/D 251 35aAaBuK"/D 299 35aBaAkUaN"/D 263 36gBnAxUaN"/D 313 36bAaBuAuNnUbN"/D 356 36gBnAkNnNaN"/F 410 36bAuN"/',
    side: 'd 28 10eAaBnNuNnN"/D 124 10eAaEnNnNuU"/D 170 10bAaEnNuNnNaN"/D 19 11gEnAkNnUaN"/F 23 11W6AbAaEaGnAnAkAW-6NxNnw-6aNaAeNaK"/D 115 11gEnAkNnUaN"/F 119 11jAbAaBaBnAbBnAnAkAW-7NuNuXaKaAeNaK"/D 67 12bAaEnAkNnUaNaN"/D 76 12eAaBuNnNnN"/F 166 12gAbAbAaAbJnAuAkAn0NuIaNbEaAbKnNuNaUaNbN"/D 214 12eAaBuNkNaN"/F 70 13W7AaAaAaBaAuAbNaEuAkAW-8NxNnUaUaNeNaK"/D 160 13bAaBnAkKaN"/F 209 14W7AbAuEeUbAaEnAnAnAuAuUuBaAxAuAnAnNnUnXnNbUaKbNaN"/D 25 15bGkKaN"/D 121 15bGkKaN"/D 171 15bAaAnAnNnU"/D 264 15eBaBbAbAaJnExNnNnw6nGnAuNnw-6nXnNnNnNnUaUaNbAaJaNbAaAaKnNuNnKaUaN"/D 216 16bAaBkK"/F 218 16aAnN"/D 603 16bAaEnNnNnU"/D 72 17eEnAuX"/D 127 17bAuN"/D 162 17bAaEuNnK"/D 177 17bAaEnBnAnBuNiAkAuAnAW-6NnNnKaNgAa0NeNbNaX"/D 203 17eBnBuNnUaN"/D 303 17gAaAeAaAbAaEnBuAuNuNuNuNxKbKaN"/D 594 17bBnAnAnKaN"/F 597 17W6AaAaAaAaGnAnAxAkNkNnNnXaNaNaNaN"/D 30 18bAuN"/F 548 18W8EbAaBaBnAkAn0NnIaAaNaX"/D 556 18bAaBkK"/D 79 19bAuN"/D 169 19bAuN"/D 223 19gAaBnBuAW-6AkEnAnAkAxXaNbNgNeNbNaNaNaNaN"/D 403 19eAaBkNuNaN"/D 458 19eAaBnAnUnNnN"/D 545 19eEnAnNnK"/D 208 20bAaBnAuNnUaN"/D 449 20bBnBnAnXaN"/F 452 20W7AaBaAaGnAnAuAxAxNuIaUaUaNaN"/D 31 21aAbAaAaAaBnAuUnNuNxAkAnAnAnAnAuAkNnXaNaNaNbNeAW6NeN"/D 113 21bAbAW7NeNbGxAaGnAuNnNnNuNxNnKnU"/o 169 21aBuNaN"/D 214 21bAuN"/F 261 21bAbAaEnNnNuAnX"/F 401 21eAbAnAaAbUbJnBnAnAnAuAW-6NnUnNbNaXuNaNaNbN"/D 603 21bEuK"/D 80 22aBxNeN"/D 350 22gAbAbAaAaEaGaGnAnAnAuAxNnUaNbNaNaw-6nKnNnNkAnAnKaN"/D 366 22eAaEuNnNuNaN"/D 411 22eAaBuAnAnBaJnAnAuAnAxNuNnNnNjNbNaNaNaUaIaN"/D 596 22bEuK"/D 66 23eAW8AnAnAnBnBaAaEnBnAnAxNnNnXaNaNaKnKuU"/F 113 23aEaAgAbAaAaAbNaXnNgAaJnBuAuAkXnNiAuNnw-7"/o 213 23bBuU"/F 315 23aAaBaJnBnBnAnKnUnNnNnNbNbUaU"/F 359 23W6AbAaAaAaJuAnAnEnAkAuNaNaXnXnKnNnNaN"/D 405 23eBuNnN"/D 498 23bEuAnAnKaNaN"/D 507 23eAaEuNnNnU"/D 549 23aEuUaN"/D 555 23bEnNnU"/F 27 24gAbAaGnBnAnAuAuKnNiAnAnAnXbNaNaNaNaNeN"/F 77 24gAaw6nAnAnAnAuAuNaKnNnUaUaNaNaN"/F 254 24eAaAaAaGaw6nAnAiUnNxUnXaUaNaNaBbNaNuNaN"/F 301 24eAbAbAxBnBaAaAkAnAaAkAnKnXaKaBeKuNaN"/F 351 24eAaAaBnBaNaw6nAnKxBaAeAuAnAnUnNkNnXnUbNaNaBbNaUuNaN"/D 458 24bBuU"/F 500 24W7AaAaAbBnBnNuAnAaBnEaAkKnNuNaUnNnAnBnNnNnKaNaNbU"/D 600 24bAuN"/D 607 24aAaBaEuNnNW-6NgNaNaN"/F 66 25bEaEnAnAuw-6aU"/F 170 25jAeEuAnGnAuAiNnNnNxNnKgNaNbNeN"/F 219 25W6AaGnBnBuAuAxNnNnNkAnAnNnUeNeNaNaKeN"/D 248 25bAaAnAnBnNnKaN"/D 346 25bAaAnAnAuKaN"/D 396 25eGnAuNnKaN"/F 413 25bAaAbAnBaExAuInUaNaN"/D 452 25bBnAuUaN"/D 560 25aJnAnAaEnBnAuNnKaXaUnNeNaN"/D 252 26eAnAuU"/F 299 26aAnN"/D 300 26bEkUaN"/F 349 26aAnN"/D 350 26bBnAuUaN"/D 402 26aAaEkKaN"/D 462 26bAaAaAaAaGnAuNnUaUnAW-6NbNaNaU"/D 552 26bAuN"/D 594 26aAeAeAkAnBnAuNnIaN"/F 266 27aAaAgAnBnAnBnAuAnXaw-6"/D 297 27aEnAnKaN"/D 304 27gAbAaAaAaBaGkNuNnNuNnNnNnUaU"/F 308 27bAuN"/D 406 27aAnN"/D 456 27bAuN"/D 545 27aAa0AkAuBaBnAaExNnNnInX"/D 226 28bAaEuAkNaUaU"/D 255 28aBnU"/o 257 28bBuU"/o 355 28aBnU"/D 417 28bAaGuKnU"/D 511 28aEbAaJnAkUnAnAuNnKaUnNaNbAaUaN"/F 512 28aAaBuK"/F 556 28aBnGnAxNaUnUbNeN"/F 601 28W6AaAaBkAnAnAnAxNuNuNaNaUaNeN"/D 176 29eAaAaBnAnAuNuXaN"/D 353 29aBnU"/o 406 29aAnN"/D 33 30aw6nAkNnUbNaNaU"/D 116 30jAaGnAnAxNnNnXbN"/F 464 30aBnBaAW-6AnBnUnNnNnNaNeNW6N"/D 500 30aAaBnAbAaEiNnNnXaAaUaN"/D 21 31jAaEnBnAnBxNnUnKaNaNaN"/D 81 31aGnBnAkNnUbNaNaNaN"/D 129 31aAaJnAkNnUnNbNbU"/D 449 31aAgNgAkAnAaAaAaBnAkNkUnI"/F 559 31aAnN"/D 368 32gAaAaEuAiNnKaNaN"/D 606 32eJnAkUnUaNaN"/D 161 33gAaAaAaBnAnAkUnUnK"/D 211 33eAaAaAaAaBnAkNuNnNnKaN"/D 254 33bAaBkNnNaN"/D 302 33eEkNnNaN"/F 305 33aAbAaAbAaAiAiKeK"/D 351 33gEkNnU"/D 414 33gAaEuAW-6KaNbN"/F 411 34aAnN"/D 595 34bAbAaBnAuNnNnK"/F 410 35aExNaNbN"/D 459 35jAaBnAxNuUaN"/D 250 36eAaBnAuNnK"/D 299 36eGkNnUaN"/D 347 36eAaBnAuNnK"/',
    dDown: 'd 28 8bAaGnNnUuNaN"/F 119 8bAbAaAaAaAaEaBnAnAnAiAiNkUnKaUeNaXeN"/D 124 8bAaGnNnNnNnNaN"/D 17 9eEnAnAuNnUaNaN"/F 21 9W6AbBaBaBaBnAnAuAn2NnXaUbNaNaUaN"/D 113 9bAaEnAkNnUaNaN"/D 169 10eAaEnUuNnN"/D 550 10aAaBnAnAuKaNaN"/D 602 10eAaBuNuU"/D 65 11eGnAuNnKaN"/F 69 11W7BaAaAaBaAaBnAnAxAW-8NkNnXaNeNaKaN"/D 76 11bAaEnNnNnU"/F 163 11W7AbBnNuEaAaNaUeAaEnBnAuAkAW-6NuNnNuKaNaUaNaNaN"/F 552 11W6AaAaAaGaGnAxAiNkNnNnNnKaNaNbNaNaU"/D 560 11aAaAaEnAnKnNnNaN"/F 598 11gAbAbAuBaAaKbAaAaEnAnAuAxAW-7NuNnIaUaNbNbN"/D 159 12eAnAnBuKaN"/D 218 12bAaBuNnU"/D 401 12aAaAnAnBnNnUaNaN"/D 410 12bAaEnNnNnU"/F 452 12jEaAaAbNaBaBuAnAuAxAiNkKaUaUaNaUbN"/D 458 12bAaAaBnAuNnNnUaN"/D 592 12eAnAnBuKaN"/D 169 13bAaBnAnNnK"/D 209 13bAnBnAuUaNaN"/F 212 13W6AaAuBaAaKbBnEnAnAiInUnAnUbN"/F 404 13W6AaAaBnNuBeNaAaBnAkAkNiAnAnNnKaUaUaNbN"/D 448 13bBnAnAnKaN"/D 27 14bAaBkK"/D 124 14aAaBnAnNnUaN"/D 177 14aAaw6nAnAnAn0AuAuAnAnNnUnNnNnKaNaAbAaAbAW6NeNbNaUaKaN"/D 360 14aAaBnNuNaN"/D 604 14bEnNnU"/D 19 15bAaAnAuK"/D 115 15bEnAnNnUaN"/D 162 15bEnAnNnUaN"/D 211 15aBaJjNaNaKaNaNbAaGnAaAaJnAnAuNnIxAxAuAnAuNnw-6aUbUaN"/D 217 15bEnNnU"/D 501 15bEnAuAnEaEaAaAeAaAaEnAnAW-6NuNnUaNeNnUnNnNnKaUaNaUaNaN"/F 504 15jAbAaAaBaEaBnAnAnAkAaAaAnAkUnNnNkNnNnKnKaNbNaUaN"/D 597 15aAaBnAuKaN"/D 68 16bEnAuKaN"/D 75 16bAaBnAnNnK"/D 166 16bAuN"/F 209 16aBuNaN"/D 313 16bAaAaAaAaBuNiNnUaNaN"/F 356 16jAuBuAbNbUaAbExAnNkBnAxNnNaNaUaBbUuNaNbN"/D 365 16bAaEnEW-7AxAnAnAnBkNnNnUnUaNbAaAgNeNbNgKnNbN"/D 403 16aEuUaN"/D 409 16bAaAkU"/D 512 16bAaGnNnUnU"/D 258 17gAaJnBnAnAkUnIaUaN"/D 270 17eAaw6nAnAkNnw-6aNaN"/D 351 17bBnBnNnUaN"/D 359 17bBuU"/D 457 17aAaEuNnUaN"/D 551 17bEnAnNnUaN"/D 558 17aAaBuK"/D 602 17bAuN"/D 24 18bAuN"/D 120 18bAuN"/o 166 18bBuU"/F 207 18aBnU"/D 215 18bAuN"/D 406 18bAuN"/D 449 18bEnAuUaU"/D 30 19bAaAaBaGuNnUkNW-7AuAnAnAuAkXaNaNaNa2NbN"/D 72 19bAuN"/D 126 19aAaAaBaEnNnNkNxAuAnEnAaAaEnAnAkNnInw-6aUbAjNjNaN"/D 304 19bAaAaBuAnAnAnNnXaNaN"/D 353 19bBuU"/D 357 19bAuN"/F 264 20gJaAeNaEnBnAnAuAW-8NuNnNnUnIaBaBeNaNaUaUaN"/D 413 20aAaAbBaEaBaGuAkNnNnXaNaNaNnNuNkAkAnAnAuAuAnUnKaNaNaNjAeNeN"/D 461 20eAaGnAuAuNnUuAxAuBnAeAaAaEnAnAkNnNnXuNnKaUaNbAjNgNbNaN"/D 545 20bAaAaAeAjNgAaJnGnAnAuNnUaNbNaNnUnUiAaEnAkNnNnKnNnNnK"/D 555 20bAuN"/D 608 20bAaAaGuNnNnNxAiAuAnAnAnAbAbAaEnAnAuNnNnIuNnKaNaNaNbAW7NgNbN"/D 79 21aAaAaw6nKnNnNW-8AnAnAnBaAaAaGnAnAkNnKnXnXaUaNbAW8NgN"/F 308 21W9AbAaBaBnAuAuAW-8NkNnNnNaNaNaNbU"/o 356 21eAnAuU"/D 452 21bAuN"/D 512 22aEuUaN"/F 22 23W7AeBaBnBnAnAnAuAxNnNnNkNkUaNbNaNaNbN"/F 121 23gAeAaAaAnBnBuAnAnAW-6NaKnNnNaKaNbN"/F 217 23gJaAbNaBnAuAnAiUnUnNkAnAnKaNaNbNgN"/F 360 23W8AaAkAnJnAkAnNuNiNnNaUaNaNaNgN"/F 410 23eAbAaAnAnAnEnAxNnNuNxNbNbNaNaNeN"/D 504 23bBnAuUaN"/F 545 23aAaAaEaAaAeNaKnNjBaBaAnAuAuAxNnNnNnNnNnNuKaN"/F 604 23gAaAaGnAnAuAuAiUnNuNuNaNaNaNbNjN"/F 71 24W8AaAaGnAnAuAnAiKnNnNnUaNaNaN"/F 166 24a1BnAuAnGnAiUnNiAnKaNaNbNbN"/D 321 24aAaGnAuAkAnAn0NuNnNnUaNaAaAeAW8NbNbNaK"/F 457 24bBaAbNbNaBnBnAnAnAW-6NnNnNkNaUbNgN"/D 366 25gAaBaGnAkNuNnIaN"/F 496 25aAaAaBaAkAnNnXaN"/D 176 26bAbGuAiXaNbN"/D 465 26aAaAaGnAxNuNaNaNaUaN"/D 508 26bAuN"/D 513 26aEaGnAkNnUaNnNnNeNaN"/D 129 27aw8nAxNnUaNaNbUaU"/D 544 27bAaAaAaAaAaBnAkNnNnUnX"/D 32 28aJnAnAuNnNaNaNaNaU"/D 211 28eAaBaBnBnAuNnNnNnKaNaN"/D 401 29gAbAaJnAuAuNnUnw-6"/D 609 29aEnBnAkNnUbNbNaN"/D 15 30eAeAaAaBnBnAnAkNnUnw-6"/D 80 30aEnAnAkUaNbNaN"/D 161 30jAaEnBnAxUnXaN"/D 353 31jAbJnAxNnNnI"/',
    down: 'd 16 9bAaAnAnBuNnUaNaN"/F 22 9gAbAaBaAaEaBnAnAuAn0NuNnNnUaUaNaUaNaNeN"/D 28 9bAaAaBnAnNnUnU"/D 113 9bBnAnBuKaNaN"/F 117 9jAbAaBaBaBaEuAuAn0NkNnKaUaNaUaNaNbN"/D 124 9bAaGnNnUnU"/D 65 11bBnAnBuKaNaN"/F 69 11jAaAaAaAaBaAaBnAnAuAn0NkNnUaUaNaUaNaNbN"/D 75 11bAaEnNnNnU"/D 159 11bAaBnAnAnNnKaN"/D 170 11eAaEnNnNnNnN"/F 163 12W8AaAaAaAaAaEnAnAuAn1NnNnNnNnNaUbNaNaNaN"/D 219 13aAaAaBuNnNnNaN"/D 170 14aAaAaBuNnK"/D 209 14bAaAuAuAnUaNaN"/F 213 14jAaAaAaAaBnAnAnAiNbNuAnNkAnAnAnNnKaUaNbAnBbNaUuNbNaN"/D 19 15bBnAuUaN"/D 26 15bAaAnAuK"/D 114 15bEnAuKaN"/D 122 15bAaBkK"/D 162 15aGuNnNaNaN"/D 353 15bBnAuUaN"/D 363 15aAaBuNnNaN"/D 402 15bBuAnUaN"/F 405 15gAaAaAnAnAaAbUnNbBaBkAW-9NuKaNaNbNaN"/D 410 15bAaBuNnU"/D 602 15bAaBkNnNaN"/D 67 16aAaBnAuKaN"/D 74 16bAaBuNnU"/F 355 16W6AbAuBbUaAaBnAiNuAxNnUaNaBbUuNaN"/D 450 16aAaAnAuUaN"/D 458 16bAaBuNnU"/D 592 16bEnAuKaN"/F 596 16jAaAbAaBaBnBnAnAW-8NxXaUaNaUbN"/D 166 17bAuN"/D 176 17aAaJnAnAnAnNW-9AkAuAkNnNnUnKaNaNbAaAaAaAa1NbNaNaK"/D 210 17bBnAuUaN"/D 217 17bAaBuNnU"/F 452 17W6AaAuBaAaKaAaBnAuAW-8NuKaNbAnBbKnNaN"/D 496 17bBnBnAnKaU"/F 500 17jEaAbUaBaEnAnAnAuAW-7NuNnUaKaUaNbN"/D 505 17bAaEuNnK"/F 548 17jAaAaAaAaAaGnAkAW-8NkKaUaNaKbN"/D 555 17bAaBnAnNnNnNaN"/D 23 18bAuN"/D 118 18bAuN"/D 313 18eAaAaBaEnAxNnUnKaU"/D 354 18bBuU"/D 361 18bBuU"/D 366 18bAaEnAnAnAnNn1AuAnNnUnKaNbBaAa1NaUaN"/D 403 18aEuUaN"/D 410 18aAaBuNnNaN"/D 544 18bEnAnNnUaN"/D 71 19bAuN"/o 166 19bBuU"/D 214 19bAuN"/D 222 19bAaGnAnBuNW-9AuAuAuXaNaNaNaNeAaAjNaNaNaN"/D 258 19bAbw6nAnAxNnIaUbN"/D 266 19gAaBaGnAxNnUnXaN"/D 358 19bAuN"/D 451 19aEuUaN"/D 457 19bEnNnU"/D 30 20aAaAaAaJnAuKnNuNW-6AuAnBnEaAaAaGnAnAkNnNnw-6nw-6aUaUeAa0NbN"/D 126 20aBaAaAaBaEnBnJnAnAxUnUaUaNbKnNnUnNW-8AuAnAnBuNnKaUaNaNeAa0NbN"/D 305 20bAaBaGnAxNnIaNaN"/D 406 20bAuN"/D 602 20aAaBnAnNnUaN"/D 78 21aAaBaBaGnBnGnAkNnKaNaNaNaKnNnNn0AnAnAnBbAbAaGnAxNnw-6nNnKaUaUeAa0NbN"/o 214 21bAuN"/o 357 21bAuN"/D 454 21bAuN"/D 594 21bEnAnNnUaN"/F 264 22aBaBaAgNaKaw7nBnAnAuAW-9NuNnNnNnw-6aBaAgNaNaKbN"/F 310 22bAaBaAgNaUaw6nAuAuAkAiNkNnXaAgNaXaN"/D 400 22bAW9NeAaBnAnAkUiAnAkNuKaN"/D 460 22bAaEuAnAnAuNnUaNW-6AnAnBbAaBaBnAxNnXnIaNaNbAW8NbN"/D 320 23bAaGnAnBnAnAuAuAn0NuNnNnNnUaNbEaAeAjNeNbNbNaw-6"/D 498 23aEuUaN"/D 503 23bAaBuNnU"/D 547 23aEuUaN"/D 553 23bAaBuNnU"/D 605 23aAaAaGnAnNnNW-8AnEnAaBbBnAuNnKnUnNnXaNeAW8NaNaU"/F 22 24W6AbAaEaAuAuBnAnAiUnNnNnKaUaNbN"/F 115 24W8AaBaAaEuAnBW-6NnNnNuNkNaUaNaNbN"/F 354 24a1AbAaAuAuAnEaAW-7NnKuNkUaNbN"/D 509 24bEnAaAaEnBnAkNnKaNxNxAaAaEnAuNuNnNnIaNaAbAW7NbNaNaN"/D 558 24aAaGnBnGnBkIaXnNeNaU"/D 598 24bAuN"/F 67 25a0AaAaEnAnAnAnBW-6KnNuNuUaNaNaN"/F 165 25W9AaAaBaBnNkAnEaAW-8UuNkAnNnXbNbNeN"/F 405 25jBeNaNaAaEnNkAnAnEiNnUnNnNuAnAnKaNbAeNaN"/F 451 25W6AnBaAbNaNaNbAnAnAnAnAnBiNnUnNuUaNaN"/F 212 26W9AbAuAnAnEaAuAiKnNnNuAnAnNnUbNbNbN"/D 500 26bAuN"/D 550 26bAuN"/D 366 27bAaBaBnBxNnNnKaNbN"/D 462 27aBaBnBnAkNnUaNaNaNaN"/F 510 27aAnN"/D 544 27bAW8AiAaBaGnBkNnNnUnKnKaN"/D 221 28eGnAnAuNnKaNaN"/D 351 28eAbGnAuAuNnIaN"/D 400 28bAaAaGnAuNnNnNnUaNaN"/D 412 28eAaEnAnAkNnKaNaN"/F 554 28aGnEkKnUnNjN"/F 597 28W8AaAaBnNuBnAnAW-6UnNaKaN"/F 499 29gAgAnBiUnNnN"/D 30 30bJnAnAkNnUaNaUbN"/D 110 30eAbAaAaBnBxNnKnK"/D 173 30eAbGnAkNnNnKaN"/D 209 30bAaAaGnAuNnNnNnUaNaN"/F 558 31aBnU"/D 604 31bAaGnAuNnKaU"/D 160 32eAbBaBnBkNnNnNnKaN"/' };

    const decodeRef = { a: ' h 1', b: ' h 2', e: ' h 3', g: ' h 4', j: ' h 5', A: ' v 1', B: ' v 2', E: ' v 3', G: ' v 4', J: ' v 5', n: 'h -1', u: ' h -2', k: ' h -3', x: ' h -4', i: ' h -5', N: ' v -1', U: ' v -2', K: ' v -3', X: ' v -4', I: ' v -5', w: ' v ', W: ' h ', D: '<path d="M', o: '<path fill="pink" d="M', F: '<path fill="#fff" d="M', '/': '/>', d: '<path d="M', f: '<path fill="#fff" d="M' };
  const decode = s => s.split('').map(c => decodeRef[c] === undefined ? c : decodeRef[c]).join('');

  // ---- faithful constants ----
  // ---- faithful constants ----
  const CELL = 100, FRAME_MS = 140, IMPACT = 80, STEP = 50;
  const ANIM = {
    walk: [0, 1, 2, 1], stop: [0],
    fall: [3, 4, 5, 6, 5, 7], fallen: [7], standUp: [7, 8, 9, 10, 11, 12],
  };
  const ROW = { up: 0, dUp: 1, side: 2, dDown: 3, down: 4 };
  const DIR_SPRITE = {
    up: 'up', upright: 'dUp', right: 'side', downright: 'dDown',
    down: 'down', downleft: 'dDown', left: 'side', upleft: 'dUp',
  };
  const DIRS = Object.keys(DIR_SPRITE);
  const MOVE_SPEEDS = [850, 900, 950, 1000, 1100];
  const TURN_OPTIONS = [1, 1, -1, -1, 0];

  const INK = '#7c5322';         // deep straw brown — outline + pleats
  const WHT = '#e6c583';         // lit straw (pale gold highlight)
  const SHD = '#c08a3e';         // shaded straw (golden tan mid-tone)
  const RED = '#7c5322';         // collar knot — same brown, reads as a band
  const GLD = '#7c5322';         // finial knob — same brown
  const SEP = 'rgba(74,48,20,0.35)'; // cast shadow — the hat/head separator
  const HAT_W = 28, HAT_H = 14;
  const rect = (x, y, f) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${f}"/>`;

  // Finalized hat — hand-tweaked pixel drawings, baked from the studio export
  // in the workshop. 28x14 grid per direction; "x,y" -> colour.
  const HAT_PIXELS = {"down":{"1,6":"#7c5322","2,5":"#e6c583","2,6":"#7c5322","2,7":"#7c5322","3,5":"#7c5322","3,6":"#c08a3e","3,7":"#7c5322","4,5":"#7c5322","4,6":"#c08a3e","4,7":"#7c5322","5,5":"#e6c583","5,6":"#c08a3e","5,7":"#7c5322","5,8":"rgba(74,48,20,0.35)","6,4":"#7c5322","6,5":"#e6c583","6,6":"#7c5322","6,7":"#c08a3e","6,8":"#7c5322","6,9":"rgba(74,48,20,0.35)","7,4":"#e6c583","7,5":"#7c5322","7,6":"#c08a3e","7,7":"#c08a3e","7,8":"#7c5322","7,9":"rgba(74,48,20,0.35)","8,4":"#7c5322","8,5":"#e6c583","8,6":"#c08a3e","8,7":"#c08a3e","8,8":"#7c5322","8,9":"rgba(74,48,20,0.35)","9,4":"#7c5322","9,5":"#e6c583","9,6":"#c08a3e","9,7":"#c08a3e","9,8":"#7c5322","9,9":"rgba(74,48,20,0.35)","10,4":"#e6c583","10,5":"#7c5322","10,6":"#c08a3e","10,7":"#c08a3e","10,8":"#7c5322","10,9":"rgba(74,48,20,0.35)","11,4":"#7c5322","11,5":"#e6c583","11,6":"#c08a3e","11,7":"#c08a3e","11,8":"#7c5322","11,9":"rgba(74,48,20,0.35)","12,4":"#e6c583","12,5":"#e6c583","12,6":"#c08a3e","12,7":"#c08a3e","12,8":"#7c5322","12,9":"rgba(74,48,20,0.35)","13,4":"#e6c583","13,5":"#e6c583","13,6":"#c08a3e","13,7":"#c08a3e","13,8":"#7c5322","13,9":"rgba(74,48,20,0.35)","14,4":"#7c5322","14,5":"#7c5322","14,6":"#c08a3e","14,7":"#c08a3e","14,8":"#7c5322","14,9":"rgba(74,48,20,0.35)","15,4":"#c08a3e","15,5":"#e6c583","15,6":"#c08a3e","15,7":"#c08a3e","15,8":"#7c5322","15,9":"rgba(74,48,20,0.35)","16,4":"#c08a3e","16,5":"#e6c583","16,6":"#c08a3e","16,7":"#c08a3e","16,8":"#7c5322","16,9":"rgba(74,48,20,0.35)","17,4":"#7c5322","17,5":"#e6c583","17,6":"#c08a3e","17,7":"#c08a3e","17,8":"#7c5322","17,9":"rgba(74,48,20,0.35)","18,4":"#c08a3e","18,5":"#7c5322","18,6":"#c08a3e","18,7":"#c08a3e","18,8":"#7c5322","18,9":"rgba(74,48,20,0.35)","19,4":"#7c5322","19,5":"#e6c583","19,6":"#c08a3e","19,7":"#c08a3e","19,8":"#7c5322","19,9":"rgba(74,48,20,0.35)","20,4":"#7c5322","20,5":"#e6c583","20,6":"#c08a3e","20,7":"#c08a3e","20,8":"#7c5322","20,9":"rgba(74,48,20,0.35)","21,4":"#e6c583","21,5":"#7c5322","21,6":"#c08a3e","21,7":"#c08a3e","21,8":"#7c5322","21,9":"rgba(74,48,20,0.35)","22,4":"#7c5322","22,5":"#e6c583","22,6":"#7c5322","22,7":"#c08a3e","22,8":"#7c5322","22,9":"rgba(74,48,20,0.35)","23,5":"#e6c583","23,6":"#c08a3e","23,7":"#7c5322","23,8":"rgba(74,48,20,0.35)","24,5":"#7c5322","24,6":"#c08a3e","24,7":"#7c5322","25,5":"#7c5322","25,6":"#c08a3e","25,7":"#7c5322","26,5":"#e6c583","26,6":"#7c5322","26,7":"#7c5322","27,6":"#7c5322","14,0":"#d4a017","13,1":"#c0392b","14,1":"#c0392b","15,1":"#c0392b","12,2":"#7c5322","13,2":"#7c5322","14,2":"#7c5322","15,2":"#7c5322","16,2":"#c08a3e","17,2":"#7c5322","10,3":"#7c5322","11,3":"#e6c583","12,3":"#7c5322","13,3":"#e6c583","14,3":"#7c5322","15,3":"#c08a3e","16,3":"#7c5322","17,3":"#c08a3e","18,3":"#7c5322","13,0":"#7c5322","12,1":"#7c5322","11,1":"#7c5322","10,2":"#7c5322","9,2":"#7c5322","8,3":"#7c5322","7,3":"#7c5322","5,4":"#7c5322","11,2":"#7c5322","9,3":"#7c5322","16,1":"#7c5322","19,3":"#7c5322","15,0":"#7c5322","17,1":"#7c5322","18,2":"#7c5322","19,2":"#7c5322","20,3":"#7c5322","21,3":"#7c5322","23,4":"#7c5322"},"dDown":{"1,7":"#7c5322","2,6":"#e6c583","2,7":"#7c5322","2,8":"#7c5322","3,6":"#7c5322","3,7":"#c08a3e","3,8":"#7c5322","4,5":"#e6c583","4,6":"#7c5322","4,7":"#c08a3e","4,8":"#7c5322","5,5":"#7c5322","5,6":"#e6c583","5,7":"#c08a3e","5,8":"#7c5322","5,9":"rgba(74,48,20,0.35)","6,5":"#7c5322","6,6":"#7c5322","6,7":"#c08a3e","6,8":"#7c5322","6,9":"rgba(74,48,20,0.35)","7,5":"#7c5322","7,6":"#e6c583","7,7":"#c08a3e","7,8":"#7c5322","7,9":"rgba(74,48,20,0.35)","8,5":"#7c5322","8,6":"#e6c583","8,7":"#c08a3e","8,8":"#7c5322","8,9":"rgba(74,48,20,0.35)","9,4":"#7c5322","9,5":"#e6c583","9,6":"#e6c583","9,7":"#c08a3e","9,8":"#7c5322","9,9":"rgba(74,48,20,0.35)","10,4":"#e6c583","10,5":"#7c5322","10,6":"#e6c583","10,7":"#c08a3e","10,8":"#7c5322","10,9":"rgba(74,48,20,0.35)","11,4":"#7c5322","11,5":"#e6c583","11,6":"#e6c583","11,7":"#c08a3e","11,8":"#7c5322","11,9":"rgba(74,48,20,0.35)","12,4":"#e6c583","12,5":"#e6c583","12,6":"#e6c583","12,7":"#c08a3e","12,8":"#7c5322","12,9":"rgba(74,48,20,0.35)","13,4":"#c08a3e","13,5":"#7c5322","13,6":"#c08a3e","13,7":"#c08a3e","13,8":"#7c5322","13,9":"rgba(74,48,20,0.35)","14,4":"#7c5322","14,5":"#e6c583","14,6":"#c08a3e","14,7":"#c08a3e","14,8":"#7c5322","14,9":"rgba(74,48,20,0.35)","15,4":"#c08a3e","15,5":"#e6c583","15,6":"#c08a3e","15,7":"#c08a3e","15,8":"#7c5322","15,9":"rgba(74,48,20,0.35)","16,4":"#7c5322","16,5":"#e6c583","16,6":"#c08a3e","16,7":"#c08a3e","16,8":"#7c5322","16,9":"rgba(74,48,20,0.35)","17,4":"#c08a3e","17,5":"#7c5322","17,6":"#c08a3e","17,7":"#c08a3e","17,8":"#7c5322","17,9":"rgba(74,48,20,0.35)","18,4":"#7c5322","18,5":"#e6c583","18,6":"#c08a3e","18,7":"#7c5322","18,8":"rgba(74,48,20,0.35)","19,4":"#7c5322","19,5":"#e6c583","19,6":"#c08a3e","19,7":"#7c5322","19,8":"rgba(74,48,20,0.35)","20,4":"#e6c583","20,5":"#7c5322","20,6":"#c08a3e","20,7":"#7c5322","20,8":"rgba(74,48,20,0.35)","21,4":"#e6c583","21,5":"#e6c583","21,6":"#c08a3e","21,7":"#7c5322","21,8":"rgba(74,48,20,0.35)","22,4":"#7c5322","22,5":"#e6c583","22,6":"#c08a3e","22,7":"#7c5322","23,4":"#7c5322","23,5":"#e6c583","23,6":"#7c5322","24,4":"#e6c583","24,5":"#7c5322","24,6":"#7c5322","25,5":"#7c5322","1,6":"#7c5322","25,6":"#7c5322","15,0":"#d4a017","13,1":"#c0392b","14,1":"#c0392b","15,1":"#c0392b","16,1":"#c0392b","12,2":"#7c5322","13,2":"#7c5322","14,2":"#7c5322","15,2":"#c08a3e","16,2":"#7c5322","17,2":"#7c5322","10,3":"#7c5322","11,3":"#7c5322","12,3":"#7c5322","13,3":"#e6c583","14,3":"#7c5322","15,3":"#c08a3e","16,3":"#7c5322","17,3":"#7c5322","8,4":"#7c5322","11,2":"#7c5322","9,3":"#7c5322","7,4":"#7c5322","18,3":"#7c5322","17,1":"#7c5322","18,2":"#7c5322","19,2":"#7c5322","20,3":"#7c5322","21,3":"#7c5322"},"side":{"2,5":"#7c5322","3,5":"#7c5322","4,5":"#e6c583","4,6":"#7c5322","5,5":"#e6c583","5,6":"#7c5322","6,5":"#e6c583","6,6":"#7c5322","6,7":"rgba(74,48,20,0.35)","7,5":"#e6c583","7,6":"#7c5322","7,7":"rgba(74,48,20,0.35)","8,5":"#e6c583","8,6":"#7c5322","8,7":"rgba(74,48,20,0.35)","9,5":"#e6c583","9,6":"#7c5322","9,7":"rgba(74,48,20,0.35)","10,5":"#e6c583","10,6":"#c08a3e","10,7":"#7c5322","10,8":"rgba(74,48,20,0.35)","11,5":"#7c5322","11,6":"#c08a3e","11,7":"#7c5322","11,8":"rgba(74,48,20,0.35)","12,5":"#e6c583","12,6":"#c08a3e","12,7":"#7c5322","12,8":"rgba(74,48,20,0.35)","13,5":"#e6c583","13,6":"#c08a3e","13,7":"#7c5322","13,8":"rgba(74,48,20,0.35)","14,5":"#e6c583","14,6":"#c08a3e","14,7":"#7c5322","14,8":"rgba(74,48,20,0.35)","15,5":"#e6c583","15,6":"#e6c583","15,7":"#7c5322","15,8":"rgba(74,48,20,0.35)","16,5":"#e6c583","16,6":"#e6c583","16,7":"#7c5322","16,8":"rgba(74,48,20,0.35)","17,5":"#7c5322","17,6":"#e6c583","17,7":"#7c5322","17,8":"rgba(74,48,20,0.35)","18,5":"#e6c583","18,6":"#7c5322","18,7":"#7c5322","18,8":"rgba(74,48,20,0.35)","19,6":"#e6c583","19,7":"#7c5322","19,8":"rgba(74,48,20,0.35)","20,6":"#e6c583","20,7":"#7c5322","20,8":"rgba(74,48,20,0.35)","21,6":"#e6c583","21,7":"#7c5322","21,8":"rgba(74,48,20,0.35)","22,6":"#e6c583","22,7":"#7c5322","22,8":"rgba(74,48,20,0.35)","23,6":"#e6c583","23,7":"#7c5322","24,6":"#7c5322","24,7":"#7c5322","25,7":"#7c5322","26,7":"#7c5322","2,6":"#7c5322","26,6":"#7c5322","15,0":"#d4a017","14,1":"#c0392b","15,1":"#c0392b","16,1":"#c0392b","12,2":"#7c5322","13,2":"#7c5322","14,2":"#e6c583","15,2":"#c08a3e","16,2":"#7c5322","17,2":"#7c5322","11,3":"#7c5322","12,3":"#7c5322","13,3":"#e6c583","14,3":"#e6c583","15,3":"#c08a3e","16,3":"#7c5322","17,3":"#c08a3e","18,3":"#7c5322","9,4":"#7c5322","10,4":"#e6c583","11,4":"#e6c583","12,4":"#7c5322","13,4":"#e6c583","14,4":"#c08a3e","15,4":"#c08a3e","16,4":"#c08a3e","17,4":"#7c5322","18,4":"#c08a3e","19,4":"#7c5322","14,0":"#7c5322","13,1":"#7c5322","12,1":"#7c5322","11,2":"#7c5322","10,2":"#7c5322","9,2":"#7c5322","8,3":"#7c5322","7,3":"#7c5322","6,4":"#7c5322","5,4":"#7c5322","4,4":"#7c5322","17,1":"#7c5322","18,2":"#7c5322","19,3":"#7c5322","20,3":"#7c5322","21,4":"#7c5322","22,5":"#7c5322","23,5":"#7c5322"},"dUp":{"1,7":"#7c5322","2,6":"#e6c583","2,7":"#7c5322","2,8":"#7c5322","3,6":"#7c5322","3,7":"#c08a3e","3,8":"#7c5322","4,5":"#e6c583","4,6":"#7c5322","4,7":"#c08a3e","4,8":"#7c5322","5,5":"#7c5322","5,6":"#e6c583","5,7":"#c08a3e","5,8":"#7c5322","5,9":"rgba(74,48,20,0.35)","6,5":"#7c5322","6,6":"#7c5322","6,7":"#c08a3e","6,8":"#7c5322","6,9":"rgba(74,48,20,0.35)","7,5":"#7c5322","7,6":"#e6c583","7,7":"#c08a3e","7,8":"#7c5322","7,9":"rgba(74,48,20,0.35)","8,5":"#7c5322","8,6":"#e6c583","8,7":"#c08a3e","8,8":"#7c5322","8,9":"rgba(74,48,20,0.35)","9,4":"#7c5322","9,5":"#e6c583","9,6":"#e6c583","9,7":"#c08a3e","9,8":"#7c5322","9,9":"rgba(74,48,20,0.35)","10,4":"#c08a3e","10,5":"#7c5322","10,6":"#e6c583","10,7":"#c08a3e","10,8":"#7c5322","10,9":"rgba(74,48,20,0.35)","11,4":"#7c5322","11,5":"#e6c583","11,6":"#e6c583","11,7":"#c08a3e","11,8":"#7c5322","11,9":"rgba(74,48,20,0.35)","12,4":"#c08a3e","12,5":"#e6c583","12,6":"#e6c583","12,7":"#c08a3e","12,8":"#7c5322","12,9":"rgba(74,48,20,0.35)","13,4":"#e6c583","13,5":"#7c5322","13,6":"#c08a3e","13,7":"#c08a3e","13,8":"#7c5322","13,9":"rgba(74,48,20,0.35)","14,4":"#7c5322","14,5":"#e6c583","14,6":"#c08a3e","14,7":"#c08a3e","14,8":"#7c5322","14,9":"rgba(74,48,20,0.35)","15,4":"#e6c583","15,5":"#e6c583","15,6":"#c08a3e","15,7":"#c08a3e","15,8":"#7c5322","15,9":"rgba(74,48,20,0.35)","16,4":"#7c5322","16,5":"#e6c583","16,6":"#c08a3e","16,7":"#c08a3e","16,8":"#7c5322","16,9":"rgba(74,48,20,0.35)","17,4":"#e6c583","17,5":"#7c5322","17,6":"#c08a3e","17,7":"#c08a3e","17,8":"#7c5322","17,9":"rgba(74,48,20,0.35)","18,4":"#7c5322","18,5":"#e6c583","18,6":"#c08a3e","18,7":"#7c5322","18,8":"rgba(74,48,20,0.35)","19,4":"#7c5322","19,5":"#e6c583","19,6":"#c08a3e","19,7":"#7c5322","19,8":"rgba(74,48,20,0.35)","20,4":"#e6c583","20,5":"#7c5322","20,6":"#c08a3e","20,7":"#7c5322","20,8":"rgba(74,48,20,0.35)","21,4":"#e6c583","21,5":"#e6c583","21,6":"#c08a3e","21,7":"#7c5322","21,8":"rgba(74,48,20,0.35)","22,4":"#7c5322","22,5":"#e6c583","22,6":"#c08a3e","22,7":"#7c5322","23,4":"#7c5322","23,5":"#e6c583","23,6":"#7c5322","24,4":"#e6c583","24,5":"#7c5322","24,6":"#7c5322","25,5":"#7c5322","1,6":"#7c5322","25,6":"#7c5322","15,0":"#d4a017","13,1":"#c0392b","14,1":"#c0392b","15,1":"#c0392b","16,1":"#c0392b","12,2":"#7c5322","13,2":"#7c5322","14,2":"#7c5322","15,2":"#e6c583","16,2":"#7c5322","17,2":"#7c5322","10,3":"#7c5322","11,3":"#7c5322","12,3":"#7c5322","13,3":"#c08a3e","14,3":"#7c5322","15,3":"#e6c583","16,3":"#7c5322","17,3":"#7c5322","8,4":"#7c5322","11,2":"#7c5322","9,3":"#7c5322","7,4":"#7c5322","18,3":"#7c5322","17,1":"#7c5322","18,2":"#7c5322","19,2":"#7c5322","20,3":"#7c5322","21,3":"#7c5322"},"up":{"1,6":"#7c5322","2,5":"#e6c583","2,6":"#7c5322","2,7":"#7c5322","3,5":"#7c5322","3,6":"#c08a3e","3,7":"#7c5322","4,5":"#7c5322","4,6":"#c08a3e","4,7":"#7c5322","5,5":"#e6c583","5,6":"#c08a3e","5,7":"#7c5322","5,8":"rgba(74,48,20,0.35)","6,4":"#7c5322","6,5":"#e6c583","6,6":"#7c5322","6,7":"#c08a3e","6,8":"#7c5322","6,9":"rgba(74,48,20,0.35)","7,4":"#e6c583","7,5":"#7c5322","7,6":"#c08a3e","7,7":"#c08a3e","7,8":"#7c5322","7,9":"rgba(74,48,20,0.35)","8,4":"#7c5322","8,5":"#e6c583","8,6":"#c08a3e","8,7":"#c08a3e","8,8":"#7c5322","8,9":"rgba(74,48,20,0.35)","9,4":"#7c5322","9,5":"#e6c583","9,6":"#c08a3e","9,7":"#c08a3e","9,8":"#7c5322","9,9":"rgba(74,48,20,0.35)","10,4":"#c08a3e","10,5":"#7c5322","10,6":"#c08a3e","10,7":"#c08a3e","10,8":"#7c5322","10,9":"rgba(74,48,20,0.35)","11,4":"#7c5322","11,5":"#e6c583","11,6":"#c08a3e","11,7":"#c08a3e","11,8":"#7c5322","11,9":"rgba(74,48,20,0.35)","12,4":"#c08a3e","12,5":"#e6c583","12,6":"#c08a3e","12,7":"#c08a3e","12,8":"#7c5322","12,9":"rgba(74,48,20,0.35)","13,4":"#c08a3e","13,5":"#e6c583","13,6":"#c08a3e","13,7":"#c08a3e","13,8":"#7c5322","13,9":"rgba(74,48,20,0.35)","14,4":"#7c5322","14,5":"#7c5322","14,6":"#c08a3e","14,7":"#c08a3e","14,8":"#7c5322","14,9":"rgba(74,48,20,0.35)","15,4":"#e6c583","15,5":"#e6c583","15,6":"#c08a3e","15,7":"#c08a3e","15,8":"#7c5322","15,9":"rgba(74,48,20,0.35)","16,4":"#e6c583","16,5":"#e6c583","16,6":"#c08a3e","16,7":"#c08a3e","16,8":"#7c5322","16,9":"rgba(74,48,20,0.35)","17,4":"#7c5322","17,5":"#e6c583","17,6":"#c08a3e","17,7":"#c08a3e","17,8":"#7c5322","17,9":"rgba(74,48,20,0.35)","18,4":"#e6c583","18,5":"#7c5322","18,6":"#c08a3e","18,7":"#c08a3e","18,8":"#7c5322","18,9":"rgba(74,48,20,0.35)","19,4":"#7c5322","19,5":"#e6c583","19,6":"#c08a3e","19,7":"#c08a3e","19,8":"#7c5322","19,9":"rgba(74,48,20,0.35)","20,4":"#7c5322","20,5":"#e6c583","20,6":"#c08a3e","20,7":"#c08a3e","20,8":"#7c5322","20,9":"rgba(74,48,20,0.35)","21,4":"#e6c583","21,5":"#7c5322","21,6":"#c08a3e","21,7":"#c08a3e","21,8":"#7c5322","21,9":"rgba(74,48,20,0.35)","22,4":"#7c5322","22,5":"#e6c583","22,6":"#7c5322","22,7":"#c08a3e","22,8":"#7c5322","22,9":"rgba(74,48,20,0.35)","23,5":"#e6c583","23,6":"#c08a3e","23,7":"#7c5322","23,8":"rgba(74,48,20,0.35)","24,5":"#7c5322","24,6":"#c08a3e","24,7":"#7c5322","25,5":"#7c5322","25,6":"#c08a3e","25,7":"#7c5322","26,5":"#e6c583","26,6":"#7c5322","26,7":"#7c5322","27,6":"#7c5322","14,0":"#d4a017","13,1":"#c0392b","14,1":"#c0392b","15,1":"#c0392b","12,2":"#7c5322","13,2":"#7c5322","14,2":"#7c5322","15,2":"#7c5322","16,2":"#e6c583","17,2":"#7c5322","10,3":"#7c5322","11,3":"#c08a3e","12,3":"#7c5322","13,3":"#c08a3e","14,3":"#7c5322","15,3":"#e6c583","16,3":"#7c5322","17,3":"#e6c583","18,3":"#7c5322","13,0":"#7c5322","12,1":"#7c5322","11,1":"#7c5322","10,2":"#7c5322","9,2":"#7c5322","8,3":"#7c5322","7,3":"#7c5322","5,4":"#7c5322","11,2":"#7c5322","9,3":"#7c5322","16,1":"#7c5322","19,3":"#7c5322","15,0":"#7c5322","17,1":"#7c5322","18,2":"#7c5322","19,2":"#7c5322","20,3":"#7c5322","21,3":"#7c5322","23,4":"#7c5322"}};
  // The hat sits steady on the head. The per-frame head bob comes entirely from
  // the seat (HAT_FIT) moving the whole hat as a unit — no shearing of the
  // drawing, which had read as jank (a triangle wobbling atop the head).
  const hatArt = dir => {
    const px = HAT_PIXELS[dir];
    let out = '';
    for (const k in px) {
      const i = k.indexOf(',');
      out += rect(+k.slice(0, i), +k.slice(i + 1), px[k]);
    }
    return out;
  };
  // per-frame seats: brim centre over the measured head centre, brim just above
  // the head top; f1 is the mid-stride dip. Tuned on the bench; the taller 3-D
  // cone seats a couple units higher than the round-6 flat hat did.
  const HAT_FIT_DEFAULT = {
    down:  [{ x: 9, y: 6 }, { x: 8, y: 7 }, { x: 8, y: 6 }],
    dDown: [{ x: 9, y: 5 }, { x: 9, y: 7 }, { x: 9, y: 5 }],
    side:  [{ x: 11, y: 7 }, { x: 11, y: 9 }, { x: 11, y: 7 }],
    dUp:   [{ x: 10, y: 6 }, { x: 10, y: 7 }, { x: 10, y: 6 }],
    up:    [{ x: 10, y: 4 }, { x: 10, y: 6 }, { x: 10, y: 4 }],
  };
  const HAT_FIT = JSON.parse(JSON.stringify(HAT_FIT_DEFAULT));
  // standalone copy for the knocked-off hat on the ground (rebuilt from pixels)
  const looseHatSvg = () =>
    `<svg viewBox="0 0 ${HAT_W} ${HAT_H}" width="60" height="30" aria-hidden="true">${hatArt('down', 1)}</svg>`;
  const HAT_CFG = {
    drop:   { follow: false, toss: 0,   spin: 34,  hurry: null, pause: 750 },
    launch: { follow: true,  toss: 150, spin: 260, hurry: 470,  pause: 450 },
  };

  // nearest of the 8 compass headings toward (dx, dy); '' when already there
  const heading = (dx, dy, t = 26) => {
    let d = '';
    if (dy < -t) d = 'up'; else if (dy > t) d = 'down';
    if (dx < -t) d += 'left'; else if (dx > t) d += 'right';
    return d;
  };

  const hatG = (dir, f) => {
    const s = HAT_FIT[dir][f];
    return `<g class="wornhat" transform="translate(${f * 48 + s.x}, ${s.y})">${hatArt(dir, f)}</g>`;
  };
  // the worn hat is composited into the walk/stop cells (0,1,2) of each row's
  // sprite svg; fall & stand-up cells stay hatless — it's on the ground by then
  const hatGroup = dir => [0, 1, 2].map(f => hatG(dir, f)).join('');
  const spriteBlock = hasHat => Object.keys(ROW).map(dir =>
    `<svg x="0px" y="0px" width="100%" height="20%" viewBox="0 0 624 48">${decode(pandaSvg[dir])}${hasHat ? hatGroup(dir) : ''}</svg>`
  ).join('');

  // ===================== a panda =====================
  class Panda {
    constructor(x, y, hasHat = false, entering = false) {
      this.el = document.createElement('div');
      this.el.className = 'panda_wrapper';
      this.el.innerHTML = `
        <div class="panda_inner_wrapper">
          <div class="panda_sprite">${spriteBlock(hasHat)}</div>
          <div class="hit_wrapper"><div class="hit_area">
            ${['upleft', 'upright', 'downleft', 'downright'].map(d =>
              `<div class="hit_corner" data-pos="${d}"></div>`).join('')}
          </div></div>
        </div>`;
      this.inner = this.el.querySelector('.panda_inner_wrapper');
      this.sprite = this.el.querySelector('.panda_sprite');
      this.corners = [...this.el.querySelectorAll('.hit_corner')];
      this.corners.forEach(c => { c.panda = this; });
      this.el.style.marginLeft = x + 'px';
      this.el.style.marginTop = y + 'px';
      this.el.style.zIndex = y;
      this.x = x; this.y = y;
      this.prev = [x, y];
      this.frame = 0;
      this.animation = reduced ? 'stop' : 'walk';
      this.turnIndex = Math.floor(Math.random() * 7);
      this.direction = pick(DIRS);
      this.defaultFallDirection = pick(DIRS);
      this.moveSpeed = pick(MOVE_SPEEDS);
      this.hit = false; this.knocked = false; this.stopped = false;
      this.hasHat = hasHat; this.hatLost = false; this.hatRest = null; this.retrieving = false;
      this.moveQueued = false;
      this.entering = entering;    // Phase 1: walking in from off-stage, not yet wandering
      this.timers = [];
      this.el.addEventListener('click', () => this.tap());
      stage.appendChild(this.el);
      this.setFacing();
      this.drawFrame();
      if (!reduced) { this.animate(); if (!entering) this.moveAbout(); }
    }
    after(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
    setAnimation(name) { this.frame = 0; this.animation = name; }
    setFacing() {
      this.inner.className = `panda_inner_wrapper facing_${this.direction}`;
    }
    refreshSprite() { // bench nudges re-composite the worn hat live
      this.sprite.innerHTML = spriteBlock(this.hasHat);
      if (this.hatLost) this.el.classList.add('hatless');
    }
    drawFrame() {
      const frames = ANIM[this.animation];
      this.sprite.style.marginLeft = `-${frames[this.frame] * CELL}px`;
      this.sprite.style.marginTop = `-${CELL * ROW[DIR_SPRITE[this.direction]]}px`;
      this.frame = this.frame === frames.length - 1 ? 0 : this.frame + 1;
    }
    animate() {
      this.drawFrame();
      this.after(FRAME_MS, () => this.animate());
    }
    applyPos(x, y) { // boundary clamp (hers: lower -40, upper 60) + the hero fence
      const lower = -40, upper = 60;
      if (x > lower && x < stage.clientWidth - upper && !inForbid(x, this.y)) {
        this.el.style.marginLeft = x + 'px'; this.x = x; this.prev[0] = x;
      }
      if (y > lower && y < stage.clientHeight - upper && !inForbid(this.x, y)) {
        this.el.style.marginTop = y + 'px'; this.y = y; this.prev[1] = y;
        this.el.style.zIndex = y;
      }
    }
    moveAbout() {
      if (this.hit || this.retrieving) return;
      this.turnIndex += pick(TURN_OPTIONS);
      if (this.turnIndex < 0) this.turnIndex = 7;
      if (this.turnIndex > 7) this.turnIndex = 0;
      this.direction = DIRS[this.turnIndex];
      this.setFacing();
      const dir = this.direction;
      let x = this.x, y = this.y;
      if (dir !== 'up' && dir !== 'down') x += dir.includes('left') ? -STEP : STEP;
      if (dir !== 'left' && dir !== 'right') y += dir.includes('up') ? -STEP : STEP;
      const bx = this.x, by = this.y;
      this.applyPos(x, y);
      if (this.x === bx && this.y === by) {
        // fully blocked by a page edge or the hero fence — bounce: turn around so
        // the panda walks away instead of moonwalking in place against the wall.
        // (a partial, one-axis block still moves, so it just slides along the edge)
        this.turnIndex = (this.turnIndex + 4) % 8;
        this.direction = DIRS[this.turnIndex];
        this.setFacing();
      }
      this.scheduleMove();
    }
    scheduleMove() {
      if (this.moveQueued) return;
      this.moveQueued = true;
      this.after(this.moveSpeed, () => { this.moveQueued = false; this.moveAbout(); });
    }
    // ---- Phase 1: the entrance ----
    // direct, unclamped placement — used only while walking in from off-stage,
    // where the normal applyPos edge/fence clamp would block the entry corridor.
    setPos(x, y) {
      this.el.style.marginLeft = x + 'px';
      this.el.style.marginTop = y + 'px';
      this.el.style.zIndex = Math.round(y);
      this.x = x; this.y = y; this.prev = [x, y];
    }
    // amble in a straight line from an off-stage edge to (tx, ty), then hand off
    // to the ordinary wander. Heading is fixed inward so the sprite faces the way
    // it walks; the 2s CSS glide on the wrapper smooths each stride, exactly as it
    // does for normal movement.
    walkIn(dir, tx, ty) {
      if (reduced) { this.entering = false; return; }
      this.direction = dir; this.turnIndex = DIRS.indexOf(dir);
      this.setFacing();
      const stride = () => {
        const dx = tx - this.x, dy = ty - this.y;
        if (Math.abs(dx) <= STEP && Math.abs(dy) <= STEP) {
          this.setPos(tx, ty);
          this.entering = false;
          this.moveAbout();                    // arrived — join the troupe
          return;
        }
        this.setPos(
          this.x + (dx > STEP ? STEP : dx < -STEP ? -STEP : 0),
          this.y + (dy > STEP ? STEP : dy < -STEP ? -STEP : 0));
        this.after(this.moveSpeed, stride);
      };
      stride();
    }
    slide() {
      let x = this.x, y = this.y;
      if (this.hit.includes('left')) x += IMPACT;
      if (this.hit.includes('right')) x -= IMPACT;
      if (this.hit.includes('up')) y += IMPACT;
      if (this.hit.includes('down')) y -= IMPACT;
      this.applyPos(x, y);
    }
    knock() {
      if (this.knocked) return;
      this.knocked = true; this.stopped = true;
      this.el.classList.add('stop');
      this.setFacing();
      this.slide();
      if (this.hasHat && !this.hatLost) this.dropHat();
      this.setAnimation('fall');
      const a = FRAME_MS * 6;                       // fall plays through
      const b = 1000 * (rand(4) + 1);               // lies there 2-5s
      const c = FRAME_MS * 6;                       // stand-up plays through
      this.after(a, () => this.setAnimation('fallen'));
      this.after(a + b, () => this.setAnimation('standUp'));
      this.after(a + b + c, () => {
        this.hit = false; this.knocked = false; this.stopped = false;
        this.el.classList.remove('stop');
        if (this.hasHat && this.hatLost) { this.retrieveHat(); return; }
        this.setAnimation('walk');
        this.moveAbout();
      });
    }
    dropHat() {
      const v = HAT_CFG[variant];
      this.hatLost = true;
      this.el.classList.add('hatless');
      const seat = HAT_FIT[DIR_SPRITE[this.direction]][0];
      const hx = this.x + Math.round(seat.x * 100 / 48), hy = this.y + Math.round(seat.y * 100 / 48);
      let dx, dy;
      if (v.follow && typeof this.hit === 'string') {
        // the hat flies the way the panda was shoved, and further
        dx = (this.hit.includes('left') ? v.toss : 0) - (this.hit.includes('right') ? v.toss : 0) + rand(40) - 20;
        dy = (this.hit.includes('up') ? v.toss : 0) - (this.hit.includes('down') ? v.toss : 0) + rand(40) - 20;
      } else {
        dx = rand(70) - 35; dy = 24 + rand(26);
      }
      const rx = Math.max(6, Math.min(stage.clientWidth - 54, hx + dx));
      const ry = Math.max(6, Math.min(stage.clientHeight - 24, hy + dy));
      const loose = document.createElement('div');
      loose.className = 'hat_loose';
      loose.innerHTML = looseHatSvg();
      loose.style.left = hx + 'px'; loose.style.top = hy + 'px';
      loose.style.zIndex = Math.round(ry);
      stage.appendChild(loose);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        loose.style.transform = `translate(${rx - hx}px, ${ry - hy}px) rotate(${v.spin}deg)`;
      }));
      this.hatRest = { x: rx, y: ry, el: loose };
    }
    retrieveHat() {
      const v = HAT_CFG[variant];
      this.retrieving = true;
      this.setAnimation('walk');
      let steps = 0;
      const stride = () => {
        if (this.knocked || !this.hatRest) return;   // a fresh knock re-enters here after stand-up
        const d = heading(this.hatRest.x - 32 - this.x, this.hatRest.y - 50 - this.y);
        if (!d || ++steps > 30) { this.pickUpHat(); return; }
        this.direction = d; this.turnIndex = DIRS.indexOf(d);
        this.setFacing();
        this.applyPos(
          this.x + (d.includes('left') ? -STEP : d.includes('right') ? STEP : 0),
          this.y + (d.includes('up') ? -STEP : d.includes('down') ? STEP : 0));
        this.after(v.hurry || this.moveSpeed, stride);
      };
      stride();
    }
    pickUpHat() {
      this.setAnimation('stop');
      this.after(HAT_CFG[variant].pause, () => {
        if (this.knocked || !this.hatRest) return;
        const loose = this.hatRest.el;
        loose.style.opacity = '0';
        setTimeout(() => loose.remove(), 200);
        this.hatRest = null; this.hatLost = false; this.retrieving = false;
        this.el.classList.remove('hatless');
        this.setAnimation('walk');
        this.moveAbout();
      });
    }
    tap() { // our one addition
      if (this.knocked || reduced) return;
      this.hit = this.defaultFallDirection;
      this.direction = this.defaultFallDirection;
      this.knock();
    }
  }

  // ---- collision: hers, at 20 Hz ----
  const overlap = (a, b) => Math.abs(a - b) < 20;
  const allCorners = () => [...stage.querySelectorAll('.hit_corner')];
  function collisionCheck() {
    if (document.hidden) return;
    const corners = allCorners();
    const hits = new Map(); // panda -> {pos: true}
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], ar = a.getBoundingClientRect();
      for (let j = i + 1; j < corners.length; j++) {
        const b = corners[j];
        // entering pandas are ghosts to collision — the walk-in must not knock
        if (a.panda === b.panda || a.panda.entering || b.panda.entering) continue;
        const br = b.getBoundingClientRect();
        if (overlap(ar.x, br.x) && overlap(ar.x + ar.width, br.x + br.width) &&
            overlap(ar.y, br.y) && overlap(ar.y + ar.height, br.y + br.height)) {
          if (!hits.has(a.panda)) hits.set(a.panda, {});
          if (!hits.has(b.panda)) hits.set(b.panda, {});
          hits.get(a.panda)[a.dataset.pos] = true;
          hits.get(b.panda)[b.dataset.pos] = true;
        }
      }
    }
    hits.forEach((h, p) => {
      const set = d => { p.direction = d; p.hit = d; };
      if (h.upleft) set('upleft');
      if (h.downleft) set('downleft');
      if (h.upright) set('upright');
      if (h.downright) set('downright');
      if (h.upleft && h.downleft) set('left');
      if (h.upright && h.downright) set('right');
      if (h.upleft && h.upright) set('up');
      if (h.downleft && h.downright) set('down');
      if (h.upleft && h.upright && h.downleft && h.downright) set(p.defaultFallDirection);
      if (!p.knocked) p.knock();
    });
  }

  // ---- Phase 1: the staggered walk-in ----
  const LEAD_GAP = 1800;      // the hat panda gets a solo beat before the troupe
  const WAVE_GAP = 1050;      // then pandas arrive a couple at a time
  const WAVE_SIZE = 2;        // "a couple"
  const OFF = 100;            // start one wrapper-width off-stage, fully clipped
  const TARGET_IN = 110;      // where the wrapper settles before it starts wandering

  // ---- spawn: ten pandas walk on from the edges, the hat panda leading ----
  const pandas = [];
  function spawn() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) { requestAnimationFrame(spawn); return; }   // wait for layout
    computeForbid();                                          // fence the hero card

    const place = () => {                                     // a clear spot off the fence
      let x, y, tries = 0;
      do {
        x = rand(Math.max(1, W - 100));
        y = rand(Math.max(1, H - 100));
      } while (inForbid(x, y) && ++tries < 40);
      return [x, y];
    };

    // reduced motion: no choreography — place them at rest, standing still
    if (reduced) {
      const [hx, hy] = place();
      pandas.push(new Panda(hx, hy, true));
      for (let i = 1; i < PANDA_COUNT; i++) { const [x, y] = place(); pandas.push(new Panda(x, y)); }
      return;
    }

    // an off-stage start + inward target on a random edge, its lane clear of the
    // fence. Entry runs perpendicular to the edge, so the straight transit never
    // crosses the centred hero card.
    const pickEntry = () => {
      for (let tries = 0; tries < 40; tries++) {
        const edge = pick(['left', 'right', 'top', 'bottom']);
        let sx, sy, dir, tx, ty;
        if (edge === 'left')   { sy = rand(H - 100); sx = -OFF;            dir = 'right'; tx = TARGET_IN;            ty = sy; }
        if (edge === 'right')  { sy = rand(H - 100); sx = W + OFF - 100;   dir = 'left';  tx = W - 100 - TARGET_IN;  ty = sy; }
        if (edge === 'top')    { sx = rand(W - 100); sy = -OFF;            dir = 'down';  ty = TARGET_IN;            tx = sx; }
        if (edge === 'bottom') { sx = rand(W - 100); sy = H + OFF - 100;   dir = 'up';    ty = H - 100 - TARGET_IN;  tx = sx; }
        if (!inForbid(tx, ty)) return { sx, sy, dir, tx, ty };
      }
      const [x, y] = place();                                 // fallback: appear at a clear spot
      return { sx: x, sy: y, dir: pick(DIRS), tx: x, ty: y };
    };

    const enterOne = hasHat => {
      const e = pickEntry();
      const p = new Panda(e.sx, e.sy, hasHat, true);
      pandas.push(p);
      p.walkIn(e.dir, e.tx, e.ty);
    };

    enterOne(true);                                           // the hat panda, alone, first
    let entered = 1;
    const wave = () => {
      if (entered >= PANDA_COUNT) return;
      const n = Math.min(WAVE_SIZE, PANDA_COUNT - entered);   // a couple at a time
      for (let k = 0; k < n; k++) enterOne(false);
      entered += n;
      setTimeout(wave, WAVE_GAP);
    };
    setTimeout(wave, LEAD_GAP);                               // give the hat panda its solo beat

    setInterval(collisionCheck, 50);
    // the fence moves with layout; recompute on resize (debounced by rAF)
    let rAF = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(rAF);
      rAF = requestAnimationFrame(computeForbid);
    });
  }
  if (document.readyState === 'complete') spawn();
  else window.addEventListener('load', spawn);
})();
