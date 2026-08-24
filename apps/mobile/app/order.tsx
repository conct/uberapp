/**
 * The checkout.
 *
 * The screen where a mistake costs actual money, so it is built to be slow in
 * the right places. The price is fetched again here rather than carried over
 * from the search, because the number somebody agrees to must be the number
 * that was just asked for. The four contact handles a registrar insists on are
 * picked from the account's own list rather than typed. And the last button
 * does not buy anything — it opens the provider's page, where the customer
 * confirms in the provider's own interface.
 *
 * Nothing on this screen can mark an order paid. That comes back from the
 * provider, signature-verified, into the agent.
 */

import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  formatMoney,
  type DomainContact,
  type OrderQuote,
  type OrderRecord,
  type PaymentProvider,
} from '@uberctrl/protocol';

import { useConnection, useMutation, useQuery } from '../src/api/hooks';
import {
  Body,
  Button,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorBanner,
  Field,
  InfoBanner,
  KeyValue,
  Loading,
  Mono,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

/** The four roles a domain must name, and what each one means to a person. */
const ROLES = [
  { key: 'registrant', label: 'Inhaber' },
  { key: 'admin', label: 'Verwaltung' },
  { key: 'tech', label: 'Technik' },
  { key: 'billing', label: 'Rechnung' },
] as const;

export default function OrderScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();
  const canSell = connection.session?.capabilities.includes('payments') ?? false;

  const params = useLocalSearchParams<{ domain: string; action: string }>();
  const domain = String(params.domain ?? '');
  const action = params.action === 'transfer' ? 'transfer' : 'register';

  // The price comes from the host, margin included. The app never works one
  // out: the margin is the seller's business and lives on the host alone.
  const prices = useQuery<{ quote: OrderQuote }>(
    'orders.quote',
    { domain, action },
    { enabled: canSell },
  );
  const contacts = useQuery<{ contacts: DomainContact[] }>('domains.contacts', undefined, {
    enabled: canSell,
  });

  const [provider, setProvider] = useState<PaymentProvider>('stripe');
  const [handles, setHandles] = useState<Record<string, number | null>>({});
  const [email, setEmail] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [checkout, setCheckout] = useState<{ order: OrderRecord; url: string } | null>(null);

  // One contact in the account is the ordinary case: a person selling domains
  // under their own handle. Preselecting it saves four identical taps, and a
  // second contact turns the choice back on.
  useEffect(() => {
    const only = contacts.data?.contacts;
    if (only && only.length === 1 && Object.keys(handles).length === 0) {
      const id = only[0]!.id;
      setHandles({ registrant: id, admin: id, tech: id, billing: id });
    }
  }, [contacts.data, handles]);

  const create = useMutation('orders.create', {
    onSuccess: (data) => {
      const answer = data as { order: OrderRecord; checkoutUrl: string };
      setCheckout({ order: answer.order, url: answer.checkoutUrl });
    },
  });

  const quote = prices.data?.quote ?? null;
  const costCents = quote ? quote.amountCents : null;
  const currency = quote?.currency ?? 'EUR';

  const missing = ROLES.filter((role) => !handles[role.key]).map((role) => role.label);
  const needsAuth = action === 'transfer' && !authCode.trim();
  const ready = costCents !== null && missing.length === 0 && !needsAuth && !create.pending;

  if (connection.state === 'ready' && !canSell) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Kein Zahlungsweg hinterlegt"
            hint="Auf diesem Host fehlen entweder die Registrar-Zugangsdaten oder die des Zahlungsanbieters. Ohne beides lässt sich eine Bestellung nicht zu Ende bringen."
          />
        </Card>
      </ScreenScroll>
    );
  }

  if (checkout) {
    return (
      <ScreenScroll>
        <Stack.Screen options={{ title: 'Zur Kasse' }} />
        <Card>
          <SectionTitle>Bestellung angelegt</SectionTitle>
          <Mono>{checkout.order.domain}</Mono>
          <KeyValue
            label="Betrag"
            value={formatMoney(checkout.order.amountCents, checkout.order.currency)}
          />
          <KeyValue label="Bezahlweg" value={provider === 'paypal' ? 'PayPal' : 'Kreditkarte'} />
          <Body muted>
            Bezahlt wird beim Anbieter, nicht hier. Sobald das Geld angekommen ist, richtet der
            Agent die Domain von selbst ein — auch wenn die App zu ist.
          </Body>
          <Button
            label="Bezahlseite öffnen"
            variant="primary"
            onPress={() => void Linking.openURL(checkout.url)}
          />
          <Button label="Zu den Bestellungen" onPress={() => router.replace('/orders')} />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll>
      <Stack.Screen options={{ title: action === 'transfer' ? 'Umzug' : 'Registrierung' }} />

      <Card>
        <SectionTitle>{action === 'transfer' ? 'Domain umziehen' : 'Domain registrieren'}</SectionTitle>
        <Mono>{domain}</Mono>
        {prices.loading ? (
          <Loading label="Frage den Preis ab…" />
        ) : prices.error ? (
          <ErrorBanner message={prices.error} onRetry={prices.refresh} />
        ) : costCents === null ? (
          <ErrorBanner message="Der Registrar nennt für diese Endung keinen Preis. Ohne Preis wird nichts bestellt." />
        ) : (
          <>
            <KeyValue label="Pro Jahr" value={formatMoney(costCents, currency)} />
            {quote && quote.renewalCents !== null ? (
              <KeyValue
                label="Verlängerung"
                value={formatMoney(quote.renewalCents, currency)}
              />
            ) : null}
            {quote && quote.amountCents !== quote.registrarCostCents ? (
              <Body muted style={{ fontSize: 12 }}>
                Einkauf {formatMoney(quote.registrarCostCents, quote.currency)} — die Differenz ist
                deine Marge.
              </Body>
            ) : null}
          </>
        )}
      </Card>

      {action === 'transfer' ? (
        <Card>
          <SectionTitle>Auth-Code</SectionTitle>
          <Field
            label="Code des bisherigen Anbieters"
            value={authCode}
            onChangeText={setAuthCode}
            monospace
            secureTextEntry
            hint="Steht im Kundenbereich des alten Anbieters. Ohne ihn lehnt der Registrar den Umzug ab."
          />
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Kontakte</SectionTitle>
        {contacts.loading ? (
          <Loading label="Lade Kontakte…" />
        ) : contacts.error ? (
          <ErrorBanner message={contacts.error} onRetry={contacts.refresh} />
        ) : (contacts.data?.contacts.length ?? 0) === 0 ? (
          <Body muted>
            Im Registrar-Konto liegt noch kein Kontakt. Ohne einen lässt sich keine Domain anmelden —
            er wird einmalig im Kundenbereich des Registrars angelegt.
          </Body>
        ) : (
          <View style={{ gap: spacing.md }}>
            {ROLES.map((role) => (
              <View key={role.key} style={{ gap: spacing.xs }}>
                <Body muted style={{ fontSize: 13, fontWeight: '600' }}>
                  {role.label}
                </Body>
                <ChoiceGroup
                  value={String(handles[role.key] ?? '')}
                  onChange={(value) =>
                    setHandles((current) => ({ ...current, [role.key]: Number(value) }))
                  }
                  options={(contacts.data?.contacts ?? []).map((contact) => ({
                    value: String(contact.id),
                    label: contact.org || contact.name,
                    hint: contact.email,
                  }))}
                />
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card>
        <SectionTitle>Bezahlung</SectionTitle>
        <ChoiceGroup
          value={provider}
          onChange={(value) => setProvider(value as PaymentProvider)}
          options={[
            { value: 'stripe', label: 'Karte', hint: 'Kredit- und Debitkarte über Stripe' },
            { value: 'paypal', label: 'PayPal', hint: 'PayPal-Konto oder Lastschrift' },
          ]}
        />
        <Field
          label="E-Mail für die Bestätigung"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          placeholder="optional"
          hint="Nur für den Beleg. Der Anbieter fragt ohnehin danach."
        />
      </Card>

      {create.error ? <ErrorBanner message={create.error} /> : null}
      {missing.length > 0 && (contacts.data?.contacts.length ?? 0) > 0 ? (
        <InfoBanner message={`Es fehlt noch ein Kontakt für: ${missing.join(', ')}.`} />
      ) : null}

      <Button
        label={
          costCents === null
            ? 'Kostenpflichtig bestellen'
            : `Kostenpflichtig bestellen — ${formatMoney(costCents, currency)}`
        }
        variant="primary"
        onPress={() =>
          void create
            .run({
              domain,
              action,
              provider,
              amountCents: costCents,
              currency,
              email: email.trim() || undefined,
              ...(action === 'transfer' ? { authCode: authCode.trim() } : {}),
              ...Object.fromEntries(ROLES.map((role) => [role.key, handles[role.key]])),
            })
            .catch(() => {})
        }
        disabled={!ready}
        loading={create.pending}
      />

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Der nächste Schritt öffnet die Seite des Zahlungsanbieters. Erst dort wird bezahlt, und erst
        danach wird die Domain angemeldet.
      </Body>
    </ScreenScroll>
  );
}
