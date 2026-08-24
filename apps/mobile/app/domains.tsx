/**
 * Domains: what the account holds, and what it could hold.
 *
 * The search sits at the top because that is what somebody opens this screen
 * to do — the list of domains already owned is reference material, and
 * reference material belongs below the thing you came for.
 *
 * Two capabilities decide what this screen is. With `domains` it manages what
 * the account already has. With `payments` as well, a free name grows a price
 * and a way to buy it. On a host with neither, the screen says so once and
 * offers nothing it cannot deliver.
 */

import { useState } from 'react';
import { View } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { formatPrice, type DomainAvailability, type RegisteredDomain } from '@uberapp/protocol';

import { useConnection, useMutation, useQuery } from '../src/api/hooks';
import {
  Badge,
  Body,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  InfoBanner,
  Loading,
  Mono,
  SectionTitle,
  spacing,
} from '../src/ui/components';
import { ScreenScroll } from '../src/ui/Screen';
import { useTheme } from '../src/ui/theme';

/** A name is worth asking about once it has a dot and something on both sides. */
function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value.trim());
}

export default function DomainsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const connection = useConnection();
  const capabilities = connection.session?.capabilities ?? [];
  const supported = capabilities.includes('domains');
  const canSell = capabilities.includes('payments');

  const domains = useQuery<{ domains: RegisteredDomain[] }>('domains.list', undefined, {
    enabled: supported,
  });

  const [term, setTerm] = useState('');
  const [checked, setChecked] = useState<DomainAvailability | null>(null);

  const check = useMutation<{ domain: string }>('domains.check', {
    onSuccess: (data) => setChecked(data as DomainAvailability),
  });

  const wanted = term.trim().toLowerCase();
  const valid = looksLikeDomain(wanted);

  if (connection.state === 'ready' && !supported) {
    return (
      <ScreenScroll>
        <Card>
          <EmptyState
            title="Kein Registrar hinterlegt"
            hint="Der Agent findet auf dem Host keine Zugangsdaten für einen Registrar. Ohne die kann er weder Domains anzeigen noch DNS-Einträge ändern."
          />
        </Card>
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll refreshing={domains.refreshing} onRefresh={domains.refresh}>
      <Card>
        <SectionTitle>Domain suchen</SectionTitle>
        <Field
          label="Wunschname"
          value={term}
          onChangeText={(value) => {
            setTerm(value);
            setChecked(null);
          }}
          placeholder="beispiel.de"
          monospace
          keyboardType="url"
          hint={
            wanted && !valid
              ? 'Ein vollständiger Name mit Endung, etwa beispiel.de'
              : 'Wird beim Registrar nachgefragt.'
          }
        />
        <Button
          label="Nachsehen"
          variant="primary"
          onPress={() => void check.run({ domain: wanted }).catch(() => {})}
          disabled={!valid || check.pending}
          loading={check.pending}
        />
      </Card>

      {check.error ? <ErrorBanner message={check.error} /> : null}

      {checked ? (
        <AvailabilityCard
          result={checked}
          canSell={canSell}
          onBuy={(action) =>
            router.push({ pathname: '/order', params: { domain: checked.domain, action } })
          }
        />
      ) : null}

      <SectionTitle>Im Konto</SectionTitle>
      {domains.loading ? (
        <Loading label="Lade Domains…" />
      ) : domains.error ? (
        <ErrorBanner message={domains.error} onRetry={domains.refresh} />
      ) : (domains.data?.domains.length ?? 0) === 0 ? (
        <Card>
          <Body muted>Noch keine Domain in diesem Konto.</Body>
        </Card>
      ) : (
        domains.data?.domains.map((entry) => <DomainRow key={entry.domain} domain={entry} />)
      )}

      {canSell ? (
        <Link href="/orders" asChild>
          <Button label="Bestellungen" onPress={() => {}} />
        </Link>
      ) : null}

      <Body muted style={{ fontSize: 12, color: theme.textFaint }}>
        Preise nennt der Registrar und sie gelten pro Jahr. Was hier steht, ist der Stand von eben —
        verbindlich wird er erst an der Kasse.
      </Body>
    </ScreenScroll>
  );
}

function AvailabilityCard({
  result,
  canSell,
  onBuy,
}: {
  result: DomainAvailability;
  canSell: boolean;
  onBuy: (action: 'register' | 'transfer') => void;
}) {
  const theme = useTheme();
  const price = formatPrice(result.price, result.currency);

  return (
    <Card style={{ borderColor: (result.available ? theme.success : theme.textFaint) + '66' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Mono style={{ flexShrink: 1 }}>{result.domain}</Mono>
        <Badge
          label={result.available ? 'frei' : 'vergeben'}
          color={result.available ? theme.success : theme.textMuted}
        />
      </View>

      {result.available ? (
        <>
          <Body>{price ? `${price} pro Jahr` : 'Der Registrar hat keinen Preis genannt.'}</Body>
          {canSell ? (
            <Button label="Registrieren" variant="primary" onPress={() => onBuy('register')} />
          ) : (
            <InfoBanner message="Auf diesem Host ist kein Zahlungsweg hinterlegt, deshalb lässt sich hier nichts kaufen." />
          )}
        </>
      ) : (
        <>
          <Body muted>
            {result.status
              ? `Die Domain ist vergeben (${result.status}).`
              : 'Die Domain ist vergeben.'}
          </Body>
          {canSell ? (
            <>
              <Body muted>
                Wenn sie dir gehört, kannst du sie hierher umziehen. Dafür brauchst du den Auth-Code
                vom bisherigen Anbieter.
              </Body>
              <Button label="Hierher umziehen" onPress={() => onBuy('transfer')} />
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

function DomainRow({ domain }: { domain: RegisteredDomain }) {
  const theme = useTheme();
  const expires = domain.expiresAt ? new Date(domain.expiresAt) : null;
  const valid = expires !== null && !Number.isNaN(expires.getTime());

  // Thirty days is roughly where a renewal stops being automatic in people's
  // heads and starts being something to check.
  const soon = valid ? expires.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000 : false;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Mono style={{ flexShrink: 1 }}>{domain.domain}</Mono>
        {soon ? <Badge label="läuft bald ab" color={theme.warning} /> : null}
      </View>
      <Body muted style={{ fontSize: 13 }}>
        {valid
          ? `Läuft am ${expires.toLocaleDateString('de-DE')}`
          : domain.status || 'Kein Ablaufdatum bekannt'}
      </Body>
      <Link href={{ pathname: '/dns/[domain]', params: { domain: domain.domain } }} asChild>
        <Button label="DNS-Einträge" onPress={() => {}} />
      </Link>
    </Card>
  );
}
