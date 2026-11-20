# C# Test Viewer

**Des résultats de tests .NET lisibles dans VS Code** — conçu pour **TUnit / Microsoft.Testing.Platform**, compatible xUnit, NUnit et MSTest.

L'explorateur de tests vous dit *qu'un* test a échoué. C# Test Viewer vous montre *pourquoi*, d'un coup d'œil : ce qui était attendu, ce qui est sorti, où, et par quels appels.

L'interface suit la langue de VS Code (anglais ou français).

![Détail des échecs](images/details-failures.png)

## Fonctionnalités

### Des échecs lisibles

- **Carte d'assertion** : l'expression (`Assert.That(total).IsEqualTo(80)`), puis **Attendu / Obtenu** avec les différences surlignées — diff caractère pour les chaînes (avec marqueur de caractère *manquant*), ligne à ligne pour le multi-lignes, valeur entière pour les nombres.
- **Comparaisons d'objets** : le membre en écart est affiché à part.
- **`Assert.Multiple`** : une carte numérotée par assertion en échec.
- **Causée par** : la chaîne des exceptions internes, avec leur type.
- **Extrait de code** autour de la ligne en échec, surligné et cliquable.
- **Pile d'appels nettoyée** : votre code d'abord, machines à états async et lambdas simplifiées, doublons fusionnés, frames framework repliées.
- **Dans l'éditeur** : `✖ attendu 80 · obtenu 100` en fin de ligne de l'assertion, message complet au survol.
- Bouton **Copier** : nom du test, message et stack trace.

### Un arbre de tests efficace

- **Projet › Classe › Méthode › Cas** (Theory / Arguments / TestCase / DataRow regroupés sous leur méthode).
- Statut, **temps réellement écoulé** (tient compte du parallélisme, ce n'est pas la somme des durées), résumé d'une ligne sur les tests en échec.
- Lancer tout, un projet, une classe, une méthode, ou **seulement les échecs**. Filtre par nom ou échecs uniquement.
- Bilan : compteurs, échecs avec leur raison, les 5 tests les plus lents.

### Une exécution rapide

1. **Un seul build, seulement si nécessaire** : sauté si rien n'a changé depuis le dernier build réussi ; `--no-restore` tant qu'aucun fichier projet n'a bougé. La cause de chaque build est indiquée.
2. **Lancement direct** des applications de test Microsoft.Testing.Platform, sans `dotnet run` ni MSBuild à chaque exécution. Les variables de `launchSettings.json` sont appliquées comme avec `dotnet run`.
3. **Projets en parallèle.**

Chaque exécution affiche ses temps dans la sortie *C# Tests* (ligne `⏱`).

## Prérequis

- SDK .NET 8 ou supérieur dans le `PATH` (ou `csTestViewer.dotnetPath`).
- **Projets Microsoft.Testing.Platform** : l'extension de rapport TRX, incluse dans le méta-paquet `TUnit` ; avec `TUnit.Engine` seul, ajouter `Microsoft.Testing.Extensions.TrxReport`.
- Cohabite avec C# Dev Kit.

## Paramètres et limites

Voir le [README anglais](README.md#settings) : mêmes paramètres, descriptions traduites dans VS Code.

Principales limites : pas de découverte avant la première exécution, pas de débogage de test, workspace approuvé requis.

## Confidentialité

Aucune télémétrie.

## Licence

[MIT](LICENSE)
