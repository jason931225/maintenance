import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Image,
  ImageBackground,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
  type TextStyle,
} from 'react-native';

import footerLogoAsset from './assets/footer-logo.png';
import heroWarehouseAsset from './assets/hero-warehouse.jpg';
import logoAsset from './assets/logo.png';
import businessConsultingAsset from './assets/source/business-consulting.jpg';
import businessEquipmentAsset from './assets/source/business-equipment.jpg';
import businessFacilityAsset from './assets/source/business-facility.jpg';
import businessFactoryAsset from './assets/source/business-factory.jpg';
import businessLogisticsAsset from './assets/source/business-logistics.jpg';
import businessProductionAsset from './assets/source/business-production.jpg';
import contactPhotoAsset from './assets/source/contact.jpg';
import contactLogoSource01Asset from './assets/source/contact-logo-source-01.png';
import contactLogoSource02Asset from './assets/source/contact-logo-source-02.png';
import contactLogoSource03Asset from './assets/source/contact-logo-source-03.jpg';
import contactLogoSource04Asset from './assets/source/contact-logo-source-04.png';
import contactLogoSource05Asset from './assets/source/contact-logo-source-05.png';
import contactLogoSource06Asset from './assets/source/contact-logo-source-06.png';
import contactLogoSource07Asset from './assets/source/contact-logo-source-07.png';
import contactLogoSource08Asset from './assets/source/contact-logo-source-08.png';
import contactLogoSource09Asset from './assets/source/contact-logo-source-09.png';
import contactLogoSource10Asset from './assets/source/contact-logo-source-10.png';
import contactLogoSource11Asset from './assets/source/contact-logo-source-11.png';
import contactLogoSource12Asset from './assets/source/contact-logo-source-12.png';
import contactLogoSource13Asset from './assets/source/contact-logo-source-13.png';
import contactLogoSource14Asset from './assets/source/contact-logo-source-14.png';
import contactLogoSource15Asset from './assets/source/contact-logo-source-15.jpg';
import contactLogoSource16Asset from './assets/source/contact-logo-source-16.jpg';
import contactLogoSource17Asset from './assets/source/contact-logo-source-17.jpg';
import contactLogoSource18Asset from './assets/source/contact-logo-source-18.jpg';
import contactLogoSource19Asset from './assets/source/contact-logo-source-19.jpg';
import contactLogoSource20Asset from './assets/source/contact-logo-source-20.jpg';
import contactLogoSource21Asset from './assets/source/contact-logo-source-21.jpg';
import sustainabilityBgAsset from './assets/source/sustainability-bg.jpg';
import sustainLeft1Asset from './assets/source/sustain-left-1.jpg';
import sustainLeft2Asset from './assets/source/sustain-left-2.jpg';
import sustainLeft3Asset from './assets/source/sustain-left-3.jpg';
import sustainRight1Asset from './assets/source/sustain-right-1.jpg';
import sustainRight2Asset from './assets/source/sustain-right-2.jpg';
import sustainRight3Asset from './assets/source/sustain-right-3.jpg';
import Video from 'react-native-video';

import {
  cossHeroVideo,
  cossPageGroups,
  cossPages,
  cossSiteRoutes,
  type CossPage,
  type CossPageGroup,
} from './cossContent';

function imageSource(
  source: ImageSourcePropType | string,
): ImageSourcePropType {
  return typeof source === 'string' ? { uri: source } : source;
}

const colors = {
  ink: '#111417',
  blue: '#2f79ff',
  white: '#ffffff',
  muted: '#6f7782',
  panel: '#f4f6f8',
  line: '#d8dde4',
};

const webOutlineTextStyle =
  Platform.OS === 'web'
    ? ({
        WebkitTextStroke: '1.25px rgba(255,255,255,0.58)',
        color: 'transparent',
      } as unknown as TextStyle)
    : null;

const images = {
  logo: imageSource(logoAsset),
  footerLogo: imageSource(footerLogoAsset),
  hero: imageSource(heroWarehouseAsset),
  production: imageSource(businessProductionAsset),
  logistics: imageSource(businessLogisticsAsset),
  facility: imageSource(businessFacilityAsset),
  equipment: imageSource(businessEquipmentAsset),
  consulting: imageSource(businessConsultingAsset),
  factory: imageSource(businessFactoryAsset),
  sustainLeft1: imageSource(sustainLeft1Asset),
  sustainLeft2: imageSource(sustainLeft2Asset),
  sustainLeft3: imageSource(sustainLeft3Asset),
  sustainRight1: imageSource(sustainRight1Asset),
  sustainRight2: imageSource(sustainRight2Asset),
  sustainRight3: imageSource(sustainRight3Asset),
  contact: imageSource(contactPhotoAsset),
  sustainabilityBg: imageSource(sustainabilityBgAsset),
  contactLogo01: imageSource(contactLogoSource01Asset),
  contactLogo02: imageSource(contactLogoSource02Asset),
  contactLogo03: imageSource(contactLogoSource03Asset),
  contactLogo04: imageSource(contactLogoSource04Asset),
  contactLogo05: imageSource(contactLogoSource05Asset),
  contactLogo06: imageSource(contactLogoSource06Asset),
  contactLogo07: imageSource(contactLogoSource07Asset),
  contactLogo08: imageSource(contactLogoSource08Asset),
  contactLogo09: imageSource(contactLogoSource09Asset),
  contactLogo10: imageSource(contactLogoSource10Asset),
  contactLogo11: imageSource(contactLogoSource11Asset),
  contactLogo12: imageSource(contactLogoSource12Asset),
  contactLogo13: imageSource(contactLogoSource13Asset),
  contactLogo14: imageSource(contactLogoSource14Asset),
  contactLogo15: imageSource(contactLogoSource15Asset),
  contactLogo16: imageSource(contactLogoSource16Asset),
  contactLogo17: imageSource(contactLogoSource17Asset),
  contactLogo18: imageSource(contactLogoSource18Asset),
  contactLogo19: imageSource(contactLogoSource19Asset),
  contactLogo20: imageSource(contactLogoSource20Asset),
  contactLogo21: imageSource(contactLogoSource21Asset),
};

const navItems: readonly Extract<
  CossPageGroup,
  'COMPANY' | 'BUSINESS' | 'SUSTAINABILITY' | 'CONTACT US'
>[] = ['COMPANY', 'BUSINESS', 'SUSTAINABILITY', 'CONTACT US'];

const heroSlides = [
  {
    label: 'INNOVATION PARTNER',
    title: 'INNOVATION PARTNER',
    outlineTitle: 'INNOVATION',
    solidTitle: 'PARTNER',
    copy: '대한민국 대표 아웃소싱 기업 (주) 코스',
  },
  {
    label: '자가공장',
    title: '자가공장',
    copy: '첨단 설비와 숙련된 기술력으로 자동차 부품의 정밀가공 및 조립공장을 직접 운영합니다.',
  },
  {
    label: '생산도급',
    title: '생산도급',
    copy: '다양한 제조 현장의 도급 운영 노하우로, 최적의 인력 운영과 공정 효율을 제공합니다.',
  },
  {
    label: '물류도급',
    title: '물류도급',
    copy: '지게차·물류장비·운영인력까지 물류와 생산 현장 전체를 통합 관리합니다.',
  },
  {
    label: '통합시설관리',
    title: '통합시설관리',
    copy: '보안·환경·안전을 아우르는 스마트한 시설운영 솔루션을 제공합니다.',
  },
] as const;

const recruitItems = [
  {
    title: '(KGM 평택공장 사내협력사) 용품 장착 차량',
    meta: '용품 장착 차량 품질검사원 채용 ~ 7월18일',
    count: '1명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49402376?Oem_Code=C1',
  },
  {
    title: '건설기계장비(지게차) 정비팀 팀장',
    meta: '지게차 정비, A/S팀장 ~ 7월12일',
    count: '1명',
    career: '경력',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49362757?Oem_Code=C1',
  },
  {
    title: '마산 소재 병원 주차장 관리 및 안내 구인',
    meta: '주차장 관리 및 안내 ~ 7월01일',
    count: '0명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49286300?Oem_Code=C1',
  },
  {
    title: '자동차부품 기업 SMT 생산기계 운용',
    meta: 'SMT 생산직 사원 구인 ~ 7월16일',
    count: '0명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49385175?Oem_Code=C1',
  },
  {
    title: '창원 특수 경비 인원 구인',
    meta: '수경비 이수증 필수/교육 희망자 가능 ~ 7월17일',
    count: '0명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49393808?Oem_Code=C1',
  },
  {
    title: '반도체 단순 검사/포장',
    meta: '조립완제품 검사 / 4일근무2일휴무 ~ 7월15일',
    count: '0명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49372911?Oem_Code=C1',
  },
  {
    title: '우림 PTS 보안인원 모집',
    meta: '보안 시설 경비 ~ 7월19일',
    count: '0명',
    career: '무관',
    url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/49414767?Oem_Code=C1',
  },
] as const;

const businessItems = [
  {
    no: '01',
    title: '생산도급',
    route: '/business/production',
    en: 'PRODUCTION SUBCONTRACTING',
    image: images.production,
  },
  {
    no: '02',
    title: '물류도급',
    route: '/business/logistics',
    en: 'LOGISTICS SUBCONTRACTING',
    image: images.logistics,
  },
  {
    no: '03',
    title: '통합시설 관리',
    route: '/business/integrated',
    en: 'INTEGRATED FACILITY MANAGEMENT',
    image: images.facility,
  },
  {
    no: '04',
    title: '물류장비',
    route: '/business/three_r',
    en: 'LOGISTICS EQUIPMENT',
    image: images.equipment,
  },
  {
    no: '05',
    title: '컨설팅',
    route: '/business/consulting',
    en: 'CONSULTING SERVICES',
    image: images.consulting,
  },
  {
    no: '06',
    title: '자가공장',
    route: '/business/own-factory',
    en: 'OWNED FACTORIES',
    image: images.factory,
  },
] as const;

const sustainabilityLeftImages = [
  images.sustainLeft3,
  images.sustainLeft1,
  images.sustainLeft2,
  images.sustainLeft3,
  images.sustainLeft1,
] as const;

const sustainabilityRightImages = [
  images.sustainRight3,
  images.sustainRight1,
  images.sustainRight2,
  images.sustainRight3,
  images.sustainRight1,
] as const;

const contactLogoImages = [
  images.contactLogo07,
  images.contactLogo08,
  images.contactLogo09,
  images.contactLogo10,
  images.contactLogo11,
  images.contactLogo12,
  images.contactLogo13,
  images.contactLogo14,
  images.contactLogo01,
  images.contactLogo02,
  images.contactLogo03,
  images.contactLogo04,
  images.contactLogo05,
  images.contactLogo06,
  images.contactLogo15,
  images.contactLogo16,
  images.contactLogo17,
  images.contactLogo18,
  images.contactLogo19,
  images.contactLogo20,
  images.contactLogo21,
] as const;

const footerGroups = [
  ['COMPANY', '가치와 비젼', '연혁', '계열사 소개', '인허가ㅣ인증'],
  [
    'BUSINESS',
    '생산도급',
    '물류도급',
    '통합시설관리',
    '물류장비',
    '컨설팅',
    '자가공장',
  ],
  ['SUSTAINABILITY', 'Net Zero', '인권과 윤리', '환경과 안전보건', '품질'],
  ['CONTACT US', '사업문의', '인재상', 'FAQ', '제보하기'],
  [
    'POLICY',
    '이용약관',
    '개인정보 취급방침',
    '이메일 무단수집 거부',
    '사이트맵',
  ],
] as const;
const footerPrimaryGroups = footerGroups.slice(0, 4);

const fullpageAnchors = [
  '',
  '#Business',
  '#Sustainability',
  '#Contact',
  '#Footered',
] as const;

type ScrollHandle = {
  scrollTo: (options: { y: number; animated?: boolean }) => void;
};
type ScrollFrameEvent = { nativeEvent: { contentOffset: { y: number } } };
type BrowserWheelEvent = { deltaY: number; preventDefault: () => void };
type BrowserWindowLike = {
  location?: { hash: string };
  addEventListener?: (
    type: 'wheel',
    listener: (event: BrowserWheelEvent) => void,
    options?: { passive?: boolean },
  ) => void;
  removeEventListener?: (
    type: 'wheel',
    listener: (event: BrowserWheelEvent) => void,
  ) => void;
};

function browserWindow() {
  return (globalThis as typeof globalThis & { window?: BrowserWindowLike })
    .window;
}

function nearestFrame(offsets: readonly number[], y: number) {
  return offsets.reduce(
    (nearest, offset, index) =>
      Math.abs(offset - y) < Math.abs(offsets[nearest] - y) ? index : nearest,
    0,
  );
}

function openExternal(url: string) {
  void Linking.openURL(url);
}

function shiftedIndex(index: number, delta: number, length: number) {
  return (index + delta + length) % length;
}

function pagesForGroup(group: CossPageGroup) {
  return cossPages.filter(page => page.group === group);
}

function publicPageUrl(page: CossPage) {
  return `https://www.cosskorea.com${page.route}`;
}

function publicRouteLabel(page: CossPage) {
  return `cosskorea.com${page.route}`;
}

function PageSelector({
  selectedPage,
  onSelectPage,
}: {
  selectedPage: CossPage;
  onSelectPage: (page: CossPage) => void;
}) {
  return (
    <View style={styles.siteSection}>
      <Text style={styles.sectionEyebrow}>FULL COSS SITE</Text>
      <Text style={styles.siteTitle}>cosskorea.com 전체 페이지</Text>
      <Text style={styles.siteLead}>
        cossok.com의 원본 사이트맵과 푸터 정책 경로까지 React Native 화면 안에서
        모두 탐색할 수 있게 구성했습니다.
      </Text>
      {cossPageGroups.map(group => (
        <View key={group} style={styles.pageGroup}>
          <Text style={styles.pageGroupTitle}>{group}</Text>
          <View style={styles.pageChipRow}>
            {pagesForGroup(group).map(page => (
              <Pressable
                key={page.id}
                accessibilityRole="button"
                accessibilityLabel={`COSS page: ${page.title}`}
                onPress={() => onSelectPage(page)}
                style={({ pressed }) => [
                  styles.pageChip,
                  selectedPage.id === page.id && styles.pageChipActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.pageChipText,
                    selectedPage.id === page.id && styles.pageChipTextActive,
                  ]}
                >
                  {page.title}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function PageDetail({ page }: { page: CossPage }) {
  return (
    <View style={styles.pageDetail}>
      <Text style={styles.pageRoute}>cosskorea.com{page.route}</Text>
      <Text style={styles.pageEyebrow}>
        {page.group} · {page.eyebrow}
      </Text>
      <Text style={styles.pageTitle}>{page.title}</Text>
      <Text style={styles.pageSubtitle}>{page.subtitle}</Text>
      <Text style={styles.pageLead}>{page.lead}</Text>
      {page.highlights ? (
        <View style={styles.pageHighlights}>
          {page.highlights.map(item => (
            <Text key={item} style={styles.pageHighlight}>
              {item}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.pageBullets}>
        {page.bullets.map(item => (
          <View key={item} style={styles.pageBulletRow}>
            <Text style={styles.pageBulletMark}>•</Text>
            <Text style={styles.pageBulletText}>{item}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function MigrationMap() {
  return (
    <View style={styles.migrationSection}>
      <Text style={styles.sectionEyebrow}>DOMAIN MIGRATION</Text>
      <Text style={styles.migrationTitle}>cossok.com → cosskorea.com</Text>
      <Text style={styles.migrationLead}>
        기존 공개 사이트 경로는 cosskorea.com으로 이동하고, 운영 콘솔은
        console.cosskorea.com에서 분리합니다.
      </Text>
      <View style={styles.routeGrid}>
        {cossSiteRoutes.map(route => (
          <Text key={route} style={styles.routePill}>
            cosskorea.com{route}
          </Text>
        ))}
      </View>
      <Text style={styles.consoleRoute}>console.cosskorea.com/login</Text>
    </View>
  );
}

function LinkButton({
  children,
  url,
  variant = 'light',
}: {
  children: string;
  url: string;
  variant?: 'light' | 'blue';
}) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => openExternal(url)}
      style={({ pressed }) => [
        styles.linkButton,
        variant === 'blue' ? styles.blueButton : styles.lightButton,
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={
          variant === 'blue' ? styles.blueButtonText : styles.lightButtonText
        }
      >
        {children}
      </Text>
    </Pressable>
  );
}

function DesktopRouteDock({
  selectedPage,
  onSelectPage,
}: {
  selectedPage: CossPage;
  onSelectPage: (page: CossPage) => void;
}) {
  const activeRoute = publicRouteLabel(selectedPage);

  return (
    <View testID="desktop-route-dock" style={styles.desktopRouteDock}>
      <View style={styles.routeDockSegment}>
        <Text style={styles.routeDockLabel}>선택 경로</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`공개 경로 열기: ${activeRoute}`}
          onPress={() => openExternal(publicPageUrl(selectedPage))}
          style={({ pressed }) => [
            styles.routeDockActiveButton,
            pressed && styles.pressed,
          ]}
        >
          <Text testID="desktop-active-route" style={styles.routeDockActiveRoute}>
            {activeRoute}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.desktopRouteRail}
      >
        {cossPages.map(page => (
          <Pressable
            key={`desktop-${page.id}`}
            accessibilityRole="button"
            accessibilityLabel={`데스크톱 사이트맵 경로: ${page.title}`}
            onPress={() => onSelectPage(page)}
            style={({ pressed }) => [
              styles.desktopRouteChip,
              selectedPage.id === page.id && styles.desktopRouteChipActive,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.desktopRouteChipText,
                selectedPage.id === page.id && styles.desktopRouteChipTextActive,
              ]}
            >
              {page.title}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.desktopRouteActions}>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="공개 홈 열기"
          onPress={() => openExternal('https://www.cosskorea.com/')}
          style={({ pressed }) => [styles.routeDockLink, pressed && styles.pressed]}
        >
          <Text style={styles.routeDockLinkText}>공개 홈</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="운영 콘솔 열기"
          onPress={() => openExternal('https://console.cosskorea.com/login')}
          style={({ pressed }) => [
            styles.routeDockLink,
            styles.routeDockConsole,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.routeDockConsoleText}>운영 콘솔</Text>
          <Text style={styles.routeDockConsoleHost}>console.cosskorea.com</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RecruitCard({
  item,
  featured,
  isWide,
}: {
  item: (typeof recruitItems)[number];
  featured: boolean;
  isWide: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Recruit listing: ${item.title}`}
      onPress={() => openExternal(item.url)}
      style={({ pressed }) => [
        styles.recruitCard,
        isWide && styles.recruitCardWide,
        featured && styles.recruitCardFeatured,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.badge, isWide && styles.badgeWide]}>채용중</Text>
      {featured ? <Text style={styles.recruitFeatureArrow}>↗</Text> : null}
      <Text
        testID={featured ? 'featured-recruit-title' : undefined}
        style={[styles.recruitCardTitle, isWide && styles.recruitCardTitleWide]}
      >
        {item.title}
      </Text>
      <View
        style={[styles.recruitMetaRow, isWide && styles.recruitMetaRowWide]}
      >
        <Text
          style={[styles.recruitMeta, isWide && styles.recruitMetaWide]}
          numberOfLines={1}
        >
          {item.meta}
        </Text>
        <Text
          style={[
            styles.recruitMetaStrong,
            isWide && styles.recruitMetaStrongWide,
          ]}
        >
          {item.count}
        </Text>
        <Text
          style={[
            styles.recruitMetaStrong,
            isWide && styles.recruitMetaStrongWide,
          ]}
        >
          {item.career}
        </Text>
      </View>
    </Pressable>
  );
}

function MobileMenu({
  onClose,
  onSelectPage,
}: {
  onClose: () => void;
  onSelectPage: (page: CossPage) => void;
}) {
  return (
    <View style={styles.mobileMenuOverlay}>
      <View style={styles.mobileMenuPanel}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close COSS mobile menu"
          onPress={onClose}
          style={styles.mobileCloseButton}
        >
          <Text style={styles.mobileCloseText}>닫기 ×</Text>
        </Pressable>
        <Text style={styles.mobileMenuTitle}>COSS SITE MAP</Text>
        <ScrollView style={styles.mobileMenuScroll}>
          {cossPageGroups.map(group => (
            <View key={group} style={styles.mobileMenuGroup}>
              <Text style={styles.mobileMenuGroupTitle}>{group}</Text>
              {pagesForGroup(group).map(page => (
                <Pressable
                  key={page.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Mobile COSS page: ${page.title}`}
                  onPress={() => {
                    onSelectPage(page);
                    onClose();
                  }}
                  style={styles.mobileMenuLink}
                >
                  <Text style={styles.mobileMenuLinkText}>{page.title}</Text>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

export function CossLandingScreen() {
  const initialPage =
    cossPages.find(page => page.id === 'vision') ?? cossPages[0];
  const [selectedPage, setSelectedPage] = useState<CossPage>(initialPage);
  const [activeHeroIndex, setActiveHeroIndex] = useState(0);
  const [activeRecruitIndex, setActiveRecruitIndex] = useState(0);
  const [activeBusinessIndex, setActiveBusinessIndex] = useState(0);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openNavGroup, setOpenNavGroup] = useState<CossPageGroup | null>(null);
  const { width, height } = useWindowDimensions();
  const isWide = width >= 768;
  const isWeb = Platform.OS === 'web';
  const frameHeight = Math.max(Math.round(height || 0), isWide ? 720 : 640);
  const footerFrameHeight = isWide ? Math.min(598, frameHeight) : frameHeight;
  const heroHeight = frameHeight;
  const frameOffsets = useMemo(
    () => [
      0,
      frameHeight,
      frameHeight * 2,
      frameHeight * 3,
      frameHeight * 3 + footerFrameHeight,
    ],
    [footerFrameHeight, frameHeight],
  );
  const scrollRef = useRef<ScrollHandle | null>(null);
  const activeFrameRef = useRef(0);
  const lastLanguageToggleAtRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const [activeFrameIndex, setActiveFrameIndex] = useState(0);
  const scrollY = useRef(new Animated.Value(0)).current;
  const webFrameTranslateY = useRef(new Animated.Value(0)).current;
  const heroReveal = useRef(new Animated.Value(0)).current;
  const recruitReveal = useRef(new Animated.Value(0)).current;
  const businessReveal = useRef(new Animated.Value(0)).current;
  const atmosphere = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // React Native Animated docs show Animated.Value + timing for declarative style transitions.
    Animated.parallel([
      Animated.timing(heroReveal, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(recruitReveal, {
        toValue: 1,
        delay: 420,
        duration: 720,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(businessReveal, {
        toValue: 1,
        delay: 640,
        duration: 780,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    const atmosphereLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(atmosphere, {
          toValue: 1,
          duration: 4200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(atmosphere, {
          toValue: 0,
          duration: 4200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    atmosphereLoop.start();

    return () => atmosphereLoop.stop();
  }, [atmosphere, businessReveal, heroReveal, recruitReveal]);

  useEffect(() => {
    activeFrameRef.current = activeFrameIndex;
  }, [activeFrameIndex]);

  const goToFrame = useCallback(
    (index: number, animated = true) => {
      const boundedIndex = Math.max(
        0,
        Math.min(index, frameOffsets.length - 1),
      );
      activeFrameRef.current = boundedIndex;
      setActiveFrameIndex(boundedIndex);
      if (isWeb) {
        Animated.timing(webFrameTranslateY, {
          toValue: -frameOffsets[boundedIndex],
          duration: animated ? 860 : 0,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: false,
        }).start();
      } else {
        scrollRef.current?.scrollTo({
          y: frameOffsets[boundedIndex],
          animated,
        });
      }

      const win = browserWindow();
      if (win?.location && fullpageAnchors[boundedIndex] !== undefined) {
        win.location.hash = fullpageAnchors[boundedIndex];
      }
    },
    [frameOffsets, isWeb, webFrameTranslateY],
  );

  useEffect(() => {
    if (!isWeb) return;
    webFrameTranslateY.setValue(
      -(frameOffsets[activeFrameRef.current] ?? frameOffsets[0] ?? 0),
    );
  }, [frameOffsets, isWeb, webFrameTranslateY]);

  const handleScrollSettled = useCallback(
    (event: ScrollFrameEvent) => {
      const index = nearestFrame(
        frameOffsets,
        event.nativeEvent.contentOffset.y,
      );
      activeFrameRef.current = index;
      setActiveFrameIndex(index);
    },
    [frameOffsets],
  );

  useEffect(() => {
    const win = browserWindow();
    if (!win?.addEventListener || !win.removeEventListener) return undefined;
    const addWheelListener = win.addEventListener.bind(win);
    const removeWheelListener = win.removeEventListener.bind(win);

    const onWheel = (event: BrowserWheelEvent) => {
      if (Math.abs(event.deltaY) < 24) return;
      event.preventDefault();

      const now = Date.now();
      if (now - lastWheelAtRef.current < 840) return;
      lastWheelAtRef.current = now;
      goToFrame(activeFrameRef.current + (event.deltaY > 0 ? 1 : -1));
    };

    addWheelListener('wheel', onWheel, { passive: false });
    return () => removeWheelListener('wheel', onWheel);
  }, [goToFrame]);

  const activeHero = heroSlides[activeHeroIndex];
  const activeBusiness = businessItems[activeBusinessIndex];
  const heroVideoUri = isWeb ? cossHeroVideo.publicUri : cossHeroVideo.legacyUri;
  const visibleRecruitItems = useMemo(
    () => [
      recruitItems[shiftedIndex(activeRecruitIndex, -1, recruitItems.length)],
      recruitItems[activeRecruitIndex],
      recruitItems[shiftedIndex(activeRecruitIndex, 1, recruitItems.length)],
    ],
    [activeRecruitIndex],
  );
  const visibleBusinessItems = useMemo(
    () => (isWide ? [...businessItems.slice(1), businessItems[0]] : businessItems),
    [isWide],
  );
  const isLightHeaderFrame =
    activeFrameIndex === 1 || activeFrameIndex === 3 || activeFrameIndex === 4;

  const heroRevealStyle = {
    opacity: heroReveal,
    transform: [
      {
        translateY: heroReveal.interpolate({
          inputRange: [0, 1],
          outputRange: [40, 0],
        }),
      },
    ],
  };
  const heroParallaxStyle = {
    transform: [
      {
        translateY: scrollY.interpolate({
          inputRange: [0, heroHeight],
          outputRange: [0, isWide ? -120 : -72],
          extrapolate: 'clamp',
        }),
      },
    ],
  };
  const fixedVideoParallaxStyle = {
    opacity: scrollY.interpolate({
      inputRange: [0, heroHeight * 0.72, heroHeight],
      outputRange: [1, 1, 0.16],
      extrapolate: 'clamp',
    }),
    transform: [
      {
        translateY: scrollY.interpolate({
          inputRange: [0, heroHeight],
          outputRange: [0, isWide ? 520 : 360],
          extrapolate: 'clamp',
        }),
      },
    ],
  };
  const recruitRevealStyle = {
    opacity: recruitReveal,
    transform: [
      {
        translateY: recruitReveal.interpolate({
          inputRange: [0, 1],
          outputRange: [18, 0],
        }),
      },
    ],
  };
  const businessRevealStyle = {
    opacity: businessReveal,
    transform: [
      {
        translateY: businessReveal.interpolate({
          inputRange: [0, 1],
          outputRange: [24, 0],
        }),
      },
      {
        scale: scrollY.interpolate({
          inputRange: [heroHeight * 0.64, heroHeight],
          outputRange: [0.985, 1],
          extrapolate: 'clamp',
        }),
      },
    ],
  };
  const atmosphereStyle = {
    opacity: atmosphere.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 0],
    }),
    transform: [
      {
        scale: atmosphere.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1.08],
        }),
      },
    ],
  };

  const selectPageByRoute = useCallback((route: string) => {
    const page = cossPages.find(item => item.route === route);
    if (page) setSelectedPage(page);
  }, []);
  const toggleLanguageMenu = useCallback(() => {
    const now = Date.now();

    if (now - lastLanguageToggleAtRef.current < 50) return;

    lastLanguageToggleAtRef.current = now;
    setLanguageOpen(value => !value);
  }, []);
  const goRecruit = (delta: number) =>
    setActiveRecruitIndex(index =>
      shiftedIndex(index, delta, recruitItems.length),
    );
  const goBusiness = (delta: number) => {
    const nextIndex = shiftedIndex(
      activeBusinessIndex,
      delta,
      businessItems.length,
    );
    setActiveBusinessIndex(nextIndex);
    selectPageByRoute(businessItems[nextIndex].route);
  };

  return (
    <View style={styles.safeArea}>
      <Animated.ScrollView
        ref={node => {
          scrollRef.current = node as unknown as ScrollHandle | null;
        }}
        testID="coss-parallax-scroll"
        style={styles.screen}
        contentContainerStyle={styles.content}
        scrollEnabled={!isWeb}
        scrollEventThrottle={16}
        decelerationRate="fast"
        disableIntervalMomentum
        pagingEnabled
        snapToAlignment="start"
        snapToOffsets={frameOffsets}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        onMomentumScrollEnd={handleScrollSettled}
        onScrollEndDrag={handleScrollSettled}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true },
        )}
      >
        <Animated.View
          testID="fullpage-transform-track"
          style={[
            styles.fullpageTrack,
            isWeb && { transform: [{ translateY: webFrameTranslateY }] },
          ]}
        >
          <ImageBackground
            testID="fullpage-frame-hero"
            source={images.hero}
            resizeMode="cover"
            style={[styles.hero, { height: heroHeight }]}
            imageStyle={styles.heroImage}
          >
            <Animated.View
              testID="fixed-video-parallax-layer"
              pointerEvents="none"
              style={[styles.fixedVideoLayer, fixedVideoParallaxStyle]}
            >
              <Video
                accessibilityLabel="COSS source hero video"
                controls={false}
                muted
                paused={false}
                repeat
                resizeMode="cover"
                source={{ uri: heroVideoUri }}
                style={styles.heroVideo}
              />
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              testID="hero-video-atmosphere"
              style={[styles.heroVideoAtmosphere, atmosphereStyle]}
            />
            <View style={styles.heroScrim} />
            <Animated.View
              testID="hero-parallax-copy"
              style={heroParallaxStyle}
            >
              <Animated.View
                testID="hero-reveal-motion"
                style={[
                  styles.heroBody,
                  isWide && styles.heroBodyWide,
                  heroRevealStyle,
                ]}
              >
                {'outlineTitle' in activeHero ? (
                  <>
                    <Text
                      style={[
                        styles.ghostTitle,
                        isWide && styles.ghostTitleWide,
                        webOutlineTextStyle,
                      ]}
                    >
                      {activeHero.outlineTitle}
                    </Text>
                    <Text
                      testID="active-hero-title"
                      style={[
                        styles.partnerTitle,
                        isWide && styles.partnerTitleWide,
                      ]}
                    >
                      {activeHero.solidTitle}
                    </Text>
                    <Text
                      accessibilityRole="header"
                      style={[styles.heroTitle, isWide && styles.heroTitleWide]}
                    >
                      {activeHero.copy}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text
                      testID="active-hero-title"
                      style={[
                        styles.partnerTitle,
                        isWide && styles.partnerTitleWide,
                      ]}
                    >
                      {activeHero.title}
                    </Text>
                    <Text
                      accessibilityRole="header"
                      style={[styles.heroTitle, isWide && styles.heroTitleWide]}
                    >
                      {activeHero.copy}
                    </Text>
                  </>
                )}
              </Animated.View>
            </Animated.View>

            <View
              testID="hero-progress-controls"
              style={[styles.heroProgress, isWide && styles.heroProgressWide]}
            >
              {heroSlides.map((slide, index) => (
                <Pressable
                  key={slide.label}
                  accessibilityRole="button"
                  accessibilityLabel={`Hero progress ${String(index + 1).padStart(2, '0')}: ${slide.label}`}
                  onPress={() => setActiveHeroIndex(index)}
                  style={styles.progressItem}
                >
                  <Text
                    style={[
                      styles.progressNumber,
                      index === activeHeroIndex && styles.progressNumberActive,
                    ]}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </Text>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        index === activeHeroIndex && styles.progressFillActive,
                      ]}
                    />
                  </View>
                </Pressable>
              ))}
            </View>

            <View
              style={[styles.recruitBand, isWide && styles.recruitBandWide]}
            >
              <Text
                style={[styles.recruitTitle, isWide && styles.recruitTitleWide]}
              >
                RECRUIT
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Recruit previous"
                onPress={() => goRecruit(-1)}
                style={[
                  styles.recruitArrowButton,
                  isWide
                    ? styles.recruitArrowLeftWide
                    : styles.recruitArrowLeft,
                ]}
              >
                <Text style={styles.recruitArrow}>‹</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Recruit next"
                onPress={() => goRecruit(1)}
                style={[
                  styles.recruitArrowButton,
                  isWide
                    ? styles.recruitArrowRightWide
                    : styles.recruitArrowRight,
                ]}
              >
                <Text style={styles.recruitArrow}>›</Text>
              </Pressable>
              {isWide ? (
                <Text pointerEvents="none" style={styles.scrollDownRail}>
                  SCROLL DOWN
                </Text>
              ) : null}
              <Animated.View
                testID="recruit-motion-row"
                style={recruitRevealStyle}
              >
                <View
                  style={[
                    styles.recruitList,
                    isWide && styles.recruitListWide,
                    !isWide && { transform: [{ translateX: width / 2 - 408 }] },
                  ]}
                >
                  {visibleRecruitItems.map((item, index) => (
                    <RecruitCard
                      key={item.title}
                      item={item}
                      featured={index === 1}
                      isWide={isWide}
                    />
                  ))}
                </View>
              </Animated.View>
            </View>
          </ImageBackground>

          <View
            testID="fullpage-frame-business"
            style={[
              styles.section,
              isWide && styles.sectionWide,
              { height: frameHeight },
            ]}
          >
            <View
              style={[
                styles.businessTextColumn,
                isWide && styles.businessTextColumnWide,
              ]}
            >
              <Text style={styles.sectionEyebrow}>BUSINESS</Text>
              <Text
                style={[
                  styles.businessHeading,
                  isWide && styles.businessHeadingWide,
                ]}
              >
                COSS는 고객 곁에서
              </Text>
              <Text
                style={[
                  styles.businessHeading,
                  isWide && styles.businessHeadingWide,
                ]}
              >
                최적의 방향을 함께 설계합니다.
              </Text>
              <Text
                testID="active-business-title"
                style={styles.activeBusinessTitle}
              >
                {activeBusiness.title}
              </Text>
              <Text style={styles.activeBusinessRoute}>
                cosskorea.com{activeBusiness.route}
              </Text>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`사업 경로 열기: ${activeBusiness.title}`}
                onPress={() =>
                  openExternal(`https://www.cosskorea.com${activeBusiness.route}`)
                }
                style={({ pressed }) => [
                  styles.viewMoreButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.viewMore}>경로 열기</Text>
              </Pressable>
              <View style={styles.businessControls}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Business previous"
                  onPress={() => goBusiness(-1)}
                  style={styles.businessControlButton}
                >
                  <Text style={styles.businessControlText}>‹</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Business next"
                  onPress={() => goBusiness(1)}
                  style={styles.businessControlButton}
                >
                  <Text style={styles.businessControlText}>›</Text>
                </Pressable>
              </View>
            </View>
            <Animated.View
              testID="business-motion-row"
              style={[
                styles.businessMotion,
                isWide && styles.businessMotionWide,
                businessRevealStyle,
                isWide && styles.businessMotionSourceOffset,
              ]}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={[
                  styles.businessGrid,
                  isWide && styles.businessGridWide,
                ]}
              >
                {visibleBusinessItems.map(item => {
                  const sourceIndex = businessItems.findIndex(
                    businessItem => businessItem.no === item.no,
                  );

                  return (
                  <Pressable
                    key={item.no}
                    accessibilityRole="button"
                    accessibilityLabel={`Business route ${item.no}: ${item.title}`}
                    onPress={() => {
                      setActiveBusinessIndex(sourceIndex);
                      selectPageByRoute(item.route);
                    }}
                    style={({ pressed }) => [
                      styles.businessPressable,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View
                      style={[
                        styles.businessCardShell,
                        isWide && styles.businessCardShellWide,
                      ]}
                    >
                      <Text style={styles.businessCardKicker}>
                        <Text style={styles.businessCardKickerNo}>
                          {item.no}
                        </Text>{' '}
                        {item.title}
                      </Text>
                      <ImageBackground
                        source={item.image}
                        resizeMode="cover"
                        style={[
                          styles.businessCard,
                          isWide && styles.businessCardWide,
                          sourceIndex === activeBusinessIndex &&
                            styles.businessCardActive,
                        ]}
                        imageStyle={[
                          styles.businessCardImage,
                          isWide && styles.businessCardImageWide,
                        ]}
                      >
                        <View style={styles.cardScrim} />
                        <View>
                          <Text
                            style={[
                              styles.cardTitle,
                              isWide && styles.cardTitleWide,
                            ]}
                          >
                            {item.title}
                          </Text>
                          <Text style={styles.cardEnglish}>{item.en}</Text>
                        </View>
                      </ImageBackground>
                    </View>
                  </Pressable>
                  );
                })}
              </ScrollView>
              {isWide ? <View style={styles.businessRailLine} /> : null}
            </Animated.View>
          </View>

          <View
            testID="fullpage-frame-sustainability"
            style={[
              styles.sustainabilitySection,
              isWide && styles.sustainabilitySectionWide,
              { height: frameHeight },
            ]}
          >
            {isWide ? (
              <Image
                source={images.sustainabilityBg}
                resizeMode="cover"
                style={styles.sustainabilityBackdrop}
              />
            ) : null}
            {isWide ? (
              <>
                <View
                    style={[
                    styles.sustainabilityColumn,
                    styles.sustainabilityColumnLeft,
                  ]}
                >
                  {sustainabilityLeftImages.map((source, index) => (
                    <Image
                      key={`left-${index}`}
                      source={source}
                      resizeMode="cover"
                      style={styles.sustainabilityColumnImage}
                    />
                  ))}
                </View>
                <View
                    style={[
                    styles.sustainabilityColumn,
                    styles.sustainabilityColumnRight,
                  ]}
                >
                  {sustainabilityRightImages.map((source, index) => (
                    <Image
                      key={`right-${index}`}
                      source={source}
                      resizeMode="cover"
                      style={styles.sustainabilityColumnImage}
                    />
                  ))}
                </View>
              </>
            ) : null}
            <View
              style={[
                styles.sustainabilityCenterPanel,
                isWide && styles.sustainabilityCenterPanelWide,
              ]}
            >
              <Text style={styles.sustainabilityEyebrow}>SUSTAINABILITY</Text>
              <Text style={styles.sustainabilityTitle}>
                행동과 혁신으로 더 나은 세상을 만듭니다
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open sustainability page"
                onPress={() =>
                  setSelectedPage(
                    cossPages.find(page => page.id === 'net-zero') ??
                      selectedPage,
                  )
                }
                style={({ pressed }) => [
                  styles.sustainabilityMoreButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.sustainabilityMoreText}>view more</Text>
                <Text style={styles.sustainabilityMoreArrow}>↗</Text>
              </Pressable>
            </View>
          </View>

          <View
            testID="fullpage-frame-contact"
            style={[
              styles.contactSection,
              isWide && styles.contactSectionWide,
              { height: frameHeight },
            ]}
          >
            <Text pointerEvents="none" style={styles.contactIntroLine}>
              <Text style={styles.contactIntroBlue}>COSS</Text>는 탄탄한 조직
              운영으로{' '}
              <Text style={styles.contactIntroBlue}>
                아웃소싱업계 최고의 경쟁력
              </Text>
              을 제공합니다.
            </Text>
            <ImageBackground
              source={images.contact}
              resizeMode="cover"
              style={[styles.contactPhoto, isWide && styles.contactPhotoWide]}
              imageStyle={styles.contactPhotoImage}
            >
              <View style={styles.contactPhotoScrim} />
              <View style={styles.contactPhotoContent}>
                <Text style={styles.contactOverlayTitle}>CONTACT US</Text>
                <Text style={styles.contactOverlayCopy}>
                  문의사항을 남겨주시면 담당자가 영업일 1일 이내로
                  연락드리겠습니다.
                </Text>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="사업 문의하기"
                  onPress={() => openExternal('mailto:cossok@cosskorea.com')}
                  style={({ pressed }) => [
                    styles.contactMoreButton,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.contactMoreButtonText}>사업 문의하기</Text>
                  <Text style={styles.contactMoreDot}>•</Text>
                </Pressable>
              </View>
            </ImageBackground>
            <View style={styles.contactLogoViewport}>
              <View
                style={[
                  styles.contactLogoBand,
                  isWide &&
                    (activeFrameIndex >= 4
                      ? styles.contactLogoBandFooterFrame
                      : styles.contactLogoBandContactFrame),
                ]}
              >
                {[...contactLogoImages, ...contactLogoImages].map(
                  (source, index) => (
                    <View key={`logo-${index}`} style={styles.contactLogoCard}>
                      <Image
                        source={source}
                        resizeMode="contain"
                        style={styles.contactLogoImage}
                      />
                    </View>
                  ),
                )}
              </View>
            </View>
            <Text pointerEvents="none" style={styles.contactGhostWord}>
              CONTACT US
            </Text>
          </View>

          <View
            testID="fullpage-frame-footer"
            style={[
              styles.footer,
              isWide && styles.footerWide,
              { height: footerFrameHeight },
            ]}
          >
            <View style={styles.footerGroups}>
              {footerPrimaryGroups.map(([title, ...links]) => (
                <View key={title} style={styles.footerGroup}>
                  <Text style={styles.footerGroupTitle}>{title}</Text>
                  {links.map(link => (
                    <Text key={link} style={styles.footerLink}>
                      › {link}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
            <DesktopRouteDock
              selectedPage={selectedPage}
              onSelectPage={setSelectedPage}
            />
            <View style={styles.footerLegal}>
              <View style={styles.footerBrandColumn}>
                <Image
                  source={images.footerLogo}
                  resizeMode="contain"
                  style={styles.footerLogo}
                  accessibilityLabel="coss"
                />
                <Text style={styles.copyright}>
                  COPYRIGHT © 2024 coss. ALL RIGHTS RESERVED.
                </Text>
                <Text style={styles.footerDomainText}>
                  (주)코스 (COSS)  |  www.cosskorea.com
                </Text>
              </View>
              <Text style={styles.footerInfo}>
                회사명 : (주)코스     |     주소 : 경남창원시 의창구 의창대로
                54번길 1 (금복빌딩 7층){`
`}
                TEL : 055-253-2720     |     FAX : 055-294-0156     |     E-mail :
                cossok@cosskorea.com
              </Text>
              <Text style={styles.privacyLink}>개인정보취급방침</Text>
            </View>
            <View style={styles.footerSiteTools}>
              <PageSelector
                selectedPage={selectedPage}
                onSelectPage={setSelectedPage}
              />
              <PageDetail page={selectedPage} />
              <MigrationMap />
            </View>
            <View style={styles.domainRow}>
              <LinkButton url="https://www.cosskorea.com/">
                www.cosskorea.com
              </LinkButton>
              <LinkButton url="https://console.cosskorea.com/login">
                console.cosskorea.com
              </LinkButton>
            </View>
          </View>
        </Animated.View>
      </Animated.ScrollView>
      <View
        style={[
          styles.headerBar,
          styles.headerBarFixed,
          isWide && styles.headerBarWide,
          activeFrameIndex === 4 && styles.headerBarWhiteFrame,
        ]}
      >
        <Image
          source={images.logo}
          resizeMode="contain"
          style={[
            styles.logo,
            isWide && styles.logoWide,
            isLightHeaderFrame ? styles.logoLightFrame : styles.logoDarkFrame,
          ]}
          accessibilityLabel="coss"
        />
        <View
          style={[
            styles.navRow,
            isWide && styles.navRowWide,
            activeFrameIndex === 2 && styles.navRowHiddenFrame,
          ]}
        >
          {navItems.map(item => (
            <Pressable
              key={item}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item} submenu`}
              onPress={() =>
                setOpenNavGroup(openNavGroup === item ? null : item)
              }
              style={({ pressed }) => [
                styles.navButton,
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.navText,
                  isLightHeaderFrame && styles.navTextLightFrame,
                ]}
              >
                {item}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Language selector"
            onPress={toggleLanguageMenu}
            style={styles.languageButton}
          >
            <Text
              style={[
                styles.languageText,
                isLightHeaderFrame && styles.languageTextLightFrame,
              ]}
            >
              ◎⌄
            </Text>
          </Pressable>
          {!isWide ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open COSS mobile menu"
              onPress={() => setMobileMenuOpen(true)}
              style={styles.mobileMenuButton}
            >
              <Text
                style={[
                  styles.mobileMenuButtonText,
                  isLightHeaderFrame && styles.mobileMenuButtonTextLightFrame,
                ]}
              >
                ☰
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {languageOpen ? (
        <View style={[styles.languageMenu, isWide && styles.languageMenuWide]}>
          <Text style={styles.languageMenuText}>KOR</Text>
          <Text style={styles.languageMenuText}>ENG</Text>
        </View>
      ) : null}

      {openNavGroup ? (
        <View style={styles.navDropdown}>
          <Text style={styles.navDropdownTitle}>{openNavGroup}</Text>
          <View style={styles.navDropdownLinks}>
            {pagesForGroup(openNavGroup).map(page => (
              <Pressable
                key={page.id}
                accessibilityRole="button"
                accessibilityLabel={`Header COSS page: ${page.title}`}
                onPress={() => setSelectedPage(page)}
                style={styles.navDropdownLink}
              >
                <Text style={styles.navDropdownText}>{page.title}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {mobileMenuOpen ? (
        <MobileMenu
          onClose={() => setMobileMenuOpen(false)}
          onSelectPage={setSelectedPage}
        />
      ) : null}
    </View>
  );
}

export default CossLandingScreen;

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.ink },
  screen: { flex: 1, backgroundColor: colors.white, overflow: 'hidden' },
  content: { backgroundColor: colors.white },
  fullpageTrack: { backgroundColor: colors.white },
  hero: {
    justifyContent: 'flex-start',
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  heroImage: { opacity: 0.02 },
  fixedVideoLayer: { ...StyleSheet.absoluteFill },
  heroVideo: { ...StyleSheet.absoluteFill, opacity: 1.08 },
  heroVideoAtmosphere: {
    position: 'absolute',
    top: 150,
    left: -120,
    width: 460,
    height: 460,
    borderRadius: 230,
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  heroScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  headerBar: {
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 8,
  },
  headerBarWide: { minHeight: 100, paddingHorizontal: 24, paddingVertical: 26 },
  headerBarFixed: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerBarWhiteFrame: { backgroundColor: colors.white },
  logo: { width: 72, height: 24 },
  logoDarkFrame: { tintColor: colors.white },
  logoLightFrame: { tintColor: '#17306f' },
  logoWide: { width: 142, height: 44 },
  navRow: { display: 'none' },
  navRowHiddenFrame: { opacity: 0 },
  navRowWide: {
    display: 'flex',
    flexDirection: 'row',
    gap: 58,
    alignItems: 'center',
    transform: [{ translateX: -38 }],
  },
  navButton: { minHeight: 36, justifyContent: 'center' },
  navText: { color: colors.white, fontSize: 17, fontWeight: '900' },
  navTextLightFrame: { color: '#565a60' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  languageButton: {
    minWidth: 50,
    minHeight: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  languageText: { color: colors.white, fontSize: 22, fontWeight: '800' },
  languageTextLightFrame: { color: '#565a60' },
  mobileMenuButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mobileMenuButtonText: {
    color: colors.white,
    fontSize: 34,
    lineHeight: 34,
    fontWeight: '300',
    marginTop: -2,
  },
  mobileMenuButtonTextLightFrame: { color: '#565a60' },
  languageMenu: {
    position: 'absolute',
    top: 52,
    right: 20,
    zIndex: 10,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: 'rgba(17,20,23,0.92)',
  },
  languageMenuWide: { top: 74, right: 28 },
  languageMenuText: {
    color: colors.white,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.3,
  },
  navDropdown: {
    position: 'absolute',
    top: 92,
    left: 250,
    right: 120,
    zIndex: 9,
    borderRadius: 26,
    padding: 24,
    backgroundColor: 'rgba(17,20,23,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  navDropdownTitle: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  navDropdownLinks: {
    marginTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  navDropdownLink: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.11)',
  },
  navDropdownText: { color: colors.white, fontSize: 13, fontWeight: '800' },
  heroBody: { paddingHorizontal: 20, paddingTop: 514 },
  heroBodyWide: { paddingHorizontal: 74, paddingTop: 468 },
  ghostTitle: {
    color: 'rgba(255,255,255,0.004)',
    fontSize: 30,
    lineHeight: 33,
    fontWeight: '900',
    letterSpacing: -1.6,
    textShadowColor: 'rgba(255,255,255,0.08)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 0,
  },
  ghostTitleWide: { fontSize: 76, lineHeight: 82, letterSpacing: -4.8 },
  partnerTitle: {
    color: colors.white,
    fontSize: 30,
    lineHeight: 34,
    fontWeight: '900',
    letterSpacing: -1.5,
  },
  partnerTitleWide: { fontSize: 76, lineHeight: 84, letterSpacing: -3.8 },
  heroTitle: {
    marginTop: 15,
    maxWidth: 620,
    color: colors.white,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '900',
    letterSpacing: -0.4,
  },
  heroTitleWide: { fontSize: 29, lineHeight: 36, letterSpacing: -0.8 },
  heroProgress: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 236,
    flexDirection: 'row',
    gap: 10,
    zIndex: 4,
  },
  heroProgressWide: {
    left: 74,
    right: 74,
    bottom: 330,
    gap: 16,
    maxWidth: 520,
    opacity: 1,
  },
  progressItem: { flex: 1, minHeight: 30, justifyContent: 'flex-end' },
  progressNumber: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '900',
  },
  progressNumberActive: { color: colors.white },
  progressBar: {
    marginTop: 5,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.24)',
  },
  progressFill: {
    width: '28%',
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  progressFillActive: { width: '100%', backgroundColor: colors.white },
  recruitBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5,
    paddingBottom: 0,
  },
  recruitBandWide: { bottom: 30, paddingBottom: 0 },
  recruitTitle: {
    paddingHorizontal: 20,
    color: colors.white,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 2,
  },
  recruitTitleWide: {
    paddingHorizontal: 0,
    textAlign: 'center',
    fontSize: 24,
    letterSpacing: -0.3,
  },
  recruitList: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  recruitListWide: {
    justifyContent: 'space-between',
    gap: 68,
    paddingHorizontal: 35,
    paddingTop: 14,
  },
  recruitCard: {
    position: 'relative',
    width: 264,
    minHeight: 148,
    borderRadius: 26,
    padding: 15,
    backgroundColor: 'rgba(255,255,255,0.13)',
  },
  recruitCardWide: {
    width: 410,
    minHeight: 137,
    borderRadius: 26,
    paddingHorizontal: 25,
    paddingVertical: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  recruitCardFeatured: { backgroundColor: 'rgba(255,255,255,0.15)' },
  badge: {
    alignSelf: 'flex-start',
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: colors.blue,
    paddingHorizontal: 10,
    paddingVertical: 4,
    color: colors.white,
    fontSize: 11,
    fontWeight: '900',
  },
  badgeWide: { paddingHorizontal: 14, paddingVertical: 7, fontSize: 13 },
  recruitCardTitle: {
    marginTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'rgba(255,255,255,0.35)',
    color: colors.white,
    fontSize: 15,
    fontWeight: '900',
  },
  recruitCardTitleWide: { marginTop: 11, fontSize: 17, lineHeight: 22 },
  recruitMetaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recruitMetaRowWide: { marginTop: 11 },
  recruitMeta: {
    flex: 1,
    color: 'rgba(255,255,255,0.68)',
    fontSize: 12,
    fontWeight: '700',
  },
  recruitMetaWide: { fontSize: 13 },
  recruitMetaStrong: { color: colors.white, fontSize: 12, fontWeight: '900' },
  recruitMetaStrongWide: { minWidth: 34, textAlign: 'right', fontSize: 13 },
  recruitFeatureArrow: {
    position: 'absolute',
    top: 15,
    right: 25,
    overflow: 'hidden',
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#2f6fe8',
    color: colors.white,
    textAlign: 'center',
    fontSize: 27,
    lineHeight: 46,
    fontWeight: '700',
  },
  recruitArrowButton: {
    position: 'absolute',
    top: 63,
    zIndex: 7,
    width: 46,
    height: 82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recruitArrow: {
    color: colors.white,
    fontSize: 72,
    lineHeight: 78,
    fontWeight: '200',
  },
  recruitArrowLeft: { left: 42 },
  recruitArrowRight: { right: 42 },
  recruitArrowLeftWide: { left: '31.4%' },
  recruitArrowRightWide: { right: '31.4%' },
  scrollDownRail: {
    position: 'absolute',
    left: -35,
    bottom: 22,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.8,
    transform: [{ rotate: '-90deg' }],
  },
  section: {
    paddingHorizontal: 22,
    paddingVertical: 76,
    backgroundColor: '#f4f4f7',
  },
  sectionWide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 58,
    paddingLeft: 70,
    paddingRight: 0,
    paddingVertical: 0,
  },
  sectionEyebrow: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 2.2,
  },
  businessTextColumn: { flexShrink: 0 },
  businessTextColumnWide: {
    width: 410,
    paddingTop: 10,
    transform: [{ translateX: -80 }, { translateY: -20 }],
  },
  businessHeading: {
    color: colors.ink,
    fontSize: 36,
    lineHeight: 43,
    fontWeight: '900',
    letterSpacing: -1.6,
  },
  businessHeadingWide: {
    color: 'rgba(17,20,23,0.10)',
    fontSize: 39,
    lineHeight: 51,
    letterSpacing: -1.9,
  },
  activeBusinessTitle: {
    marginTop: 18,
    color: colors.blue,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '900',
  },
  activeBusinessRoute: {
    marginTop: 8,
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  viewMoreButton: {
    alignSelf: 'flex-start',
    marginTop: 18,
    minHeight: 38,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.ink,
    paddingHorizontal: 16,
    justifyContent: 'center',
  },
  viewMore: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.6,
  },
  businessControls: { marginTop: 34, flexDirection: 'row', gap: 10 },
  businessControlButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  businessControlText: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 38,
    fontWeight: '300',
  },
  businessMotion: { marginTop: 34 },
  businessMotionWide: { flex: 1, marginTop: 0, position: 'relative' },
  businessMotionSourceOffset: {
    transform: [{ translateX: 0 }, { translateY: -74 }],
  },
  businessGrid: { gap: 16, paddingRight: 22 },
  businessGridWide: { gap: 28, paddingRight: 56 },
  businessRailLine: {
    position: 'absolute',
    left: 0,
    bottom: -68,
    width: 265,
    height: 1,
    backgroundColor: 'rgba(17,20,23,0.38)',
  },
  businessPressable: { borderRadius: 30 },
  businessCardShell: { width: 238 },
  businessCardShellWide: { width: 265, height: 411 },
  businessCardKicker: {
    height: 52,
    color: colors.ink,
    fontSize: 18,
    lineHeight: 52,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  businessCardKickerNo: {
    color: '#0754d9',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1.4,
  },
  businessCard: {
    width: 238,
    minHeight: 310,
    overflow: 'hidden',
    borderRadius: 24,
    justifyContent: 'space-between',
    padding: 22,
  },
  businessCardWide: { width: 265, height: 345, borderRadius: 22, padding: 56 },
  businessCardActive: {},
  businessCardImage: { borderRadius: 24 },
  businessCardImageWide: { borderRadius: 30 },
  cardScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.30)',
  },
  cardNo: {
    color: 'rgba(255,255,255,0.36)',
    fontSize: 54,
    lineHeight: 58,
    fontWeight: '900',
  },
  cardNoWide: { fontSize: 40, lineHeight: 46 },
  cardTitle: {
    color: colors.white,
    fontSize: 29,
    fontWeight: '900',
    letterSpacing: -1.1,
  },
  cardTitleWide: { fontSize: 30, lineHeight: 36, letterSpacing: -1.2 },
  cardEnglish: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.66)',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  siteSection: {
    paddingHorizontal: 22,
    paddingVertical: 76,
    backgroundColor: colors.panel,
  },
  siteTitle: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: -1.4,
  },
  siteLead: {
    marginTop: 14,
    color: colors.muted,
    fontSize: 16,
    lineHeight: 26,
    fontWeight: '700',
  },
  pageGroup: { marginTop: 28 },
  pageGroupTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 1.6,
  },
  pageChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 12,
  },
  pageChip: {
    minHeight: 42,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  pageChipActive: { borderColor: colors.blue, backgroundColor: colors.blue },
  pageChipText: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  pageChipTextActive: { color: colors.white },
  pageDetail: {
    paddingHorizontal: 22,
    paddingVertical: 72,
    backgroundColor: colors.white,
  },
  pageRoute: {
    color: colors.blue,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  pageEyebrow: {
    marginTop: 18,
    color: colors.muted,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  pageTitle: {
    marginTop: 10,
    color: colors.ink,
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '900',
    letterSpacing: -1.8,
  },
  pageSubtitle: {
    marginTop: 10,
    color: colors.ink,
    fontSize: 22,
    lineHeight: 31,
    fontWeight: '900',
    letterSpacing: -0.7,
  },
  pageLead: {
    marginTop: 18,
    color: colors.muted,
    fontSize: 17,
    lineHeight: 29,
    fontWeight: '700',
  },
  pageHighlights: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 24,
  },
  pageHighlight: {
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: colors.panel,
    color: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 13,
    fontWeight: '900',
  },
  pageBullets: { marginTop: 26, gap: 12 },
  pageBulletRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  pageBulletMark: {
    color: colors.blue,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '900',
  },
  pageBulletText: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    lineHeight: 26,
    fontWeight: '700',
  },
  migrationSection: {
    paddingHorizontal: 22,
    paddingVertical: 70,
    backgroundColor: colors.panel,
  },
  migrationTitle: {
    color: colors.ink,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: -1.4,
  },
  migrationLead: {
    marginTop: 14,
    color: colors.muted,
    fontSize: 16,
    lineHeight: 26,
    fontWeight: '700',
  },
  routeGrid: { marginTop: 24, flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  routePill: {
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: colors.white,
    color: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 12,
    fontWeight: '900',
  },
  consoleRoute: {
    marginTop: 18,
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: colors.blue,
    color: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 13,
    fontWeight: '900',
  },
  sustainabilitySection: {
    position: 'relative',
    overflow: 'hidden',
    paddingHorizontal: 22,
    paddingVertical: 84,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  sustainabilitySectionWide: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  sustainabilityBackdrop: {
    position: 'absolute',
    top: 0,
    left: '25%',
    right: '25%',
    height: 274,
  },
  sustainabilityColumn: {
    position: 'absolute',
    top: -312,
    width: 360,
    gap: 12,
  },
  sustainabilityColumnLeft: { left: 0 },
  sustainabilityColumnRight: { right: 0, top: -335 },
  sustainabilityColumnImage: { width: 360, height: 456 },
  sustainabilityCenterPanel: {
    zIndex: 2,
    alignItems: 'center',
    maxWidth: 560,
    paddingHorizontal: 22,
    transform: [{ translateY: -38 }],
  },
  sustainabilityCenterPanelWide: { opacity: 0 },
  sustainabilityEyebrow: {
    color: colors.ink,
    fontSize: 42,
    lineHeight: 52,
    fontWeight: '900',
    letterSpacing: -1.4,
  },
  sustainabilityTitle: {
    marginTop: 15,
    color: colors.ink,
    fontSize: 22,
    lineHeight: 34,
    fontWeight: '900',
    letterSpacing: -0.7,
    textAlign: 'center',
  },
  sustainabilityMoreButton: {
    marginTop: 48,
    minWidth: 190,
    minHeight: 54,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: colors.white,
  },
  sustainabilityMoreText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  sustainabilityMoreArrow: {
    color: colors.blue,
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '800',
  },
  contactSection: {
    position: 'relative',
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingVertical: 56,
    backgroundColor: colors.white,
  },
  contactSectionWide: {
    margin: 0,
    borderRadius: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  contactIntroLine: {
    zIndex: 5,
    marginTop: 446,
    width: 1030,
    maxWidth: '86%',
    color: 'rgba(17,20,23,0.26)',
    fontSize: 35,
    lineHeight: 45,
    fontWeight: '900',
    letterSpacing: -1.5,
    textAlign: 'center',
  },
  contactIntroBlue: { color: 'rgba(47,121,255,0.38)' },
  contactPhoto: {
    zIndex: 3,
    marginTop: -38,
    width: '100%',
    maxWidth: 1200,
    height: 640,
    overflow: 'hidden',
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactPhotoWide: { width: 1200 },
  contactPhotoImage: { borderRadius: 26 },
  contactPhotoScrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(255,255,255,0.24)',
  },
  contactPhotoContent: {
    width: 690,
    maxWidth: '86%',
    alignItems: 'center',
  },
  contactOverlayTitle: {
    color: 'rgba(255,255,255,0.20)',
    fontSize: 56,
    lineHeight: 64,
    fontWeight: '900',
    letterSpacing: -1.6,
  },
  contactOverlayCopy: {
    marginTop: 26,
    color: 'rgba(255,255,255,0.28)',
    fontSize: 24,
    lineHeight: 36,
    fontWeight: '900',
    letterSpacing: -0.8,
    textAlign: 'center',
  },
  contactMoreButton: {
    marginTop: 42,
    minWidth: 272,
    minHeight: 64,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.72)',
    backgroundColor: 'rgba(255,255,255,0.86)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 26,
  },
  contactMoreButtonText: {
    color: '#276fff',
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  contactMoreDot: {
    color: '#276fff',
    fontSize: 24,
    lineHeight: 25,
    fontWeight: '900',
  },
  contactLogoViewport: {
    zIndex: 4,
    width: '100%',
    height: 138,
    marginTop: 68,
    overflow: 'hidden',
  },
  contactLogoBand: {
    zIndex: 4,
    flexDirection: 'row',
    gap: 30,
    paddingHorizontal: 0,
    paddingRight: 30,
  },
  contactLogoBandContactFrame: {
    transform: [{ translateX: -140 }],
  },
  contactLogoBandFooterFrame: {
    transform: [{ translateX: -265 }],
  },
  contactLogoCard: {
    width: 275,
    height: 84,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  contactLogoImage: { width: 180, height: 70 },
  contactGhostWord: {
    position: 'absolute',
    left: -196,
    bottom: -55,
    zIndex: 1,
    color: 'rgba(47,121,255,0.035)',
    fontSize: 265,
    lineHeight: 265,
    fontWeight: '900',
    letterSpacing: -12,
  },
  desktopRouteDock: {
    minHeight: 74,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#d7dbe1',
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  routeDockSegment: { width: 260, gap: 5 },
  routeDockLabel: {
    color: '#7d8288',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  routeDockActiveButton: { minHeight: 28, justifyContent: 'center' },
  routeDockActiveRoute: {
    color: '#0754d9',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '900',
  },
  desktopRouteRail: {
    gap: 8,
    paddingRight: 6,
    alignItems: 'center',
  },
  desktopRouteChip: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d7dbe1',
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  desktopRouteChipActive: { borderColor: colors.blue, backgroundColor: colors.blue },
  desktopRouteChipText: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  desktopRouteChipTextActive: { color: colors.white },
  desktopRouteActions: {
    width: 296,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  routeDockLink: {
    minHeight: 36,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d7dbe1',
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  routeDockLinkText: { color: colors.ink, fontSize: 12, fontWeight: '900' },
  routeDockConsole: {
    minWidth: 156,
    borderColor: colors.blue,
    backgroundColor: colors.blue,
  },
  routeDockConsoleText: { color: colors.white, fontSize: 12, fontWeight: '900' },
  routeDockConsoleHost: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
  },
  linkButton: {
    minHeight: 48,
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  blueButton: { minWidth: 274, minHeight: 64, backgroundColor: colors.blue },
  lightButtonText: { color: colors.white, fontSize: 14, fontWeight: '900' },
  blueButtonText: { color: colors.white, fontSize: 17, fontWeight: '900' },
  pressed: { opacity: 0.72 },
  footer: {
    paddingHorizontal: 22,
    paddingVertical: 56,
    backgroundColor: colors.white,
    overflow: 'hidden',
  },
  footerWide: {
    paddingHorizontal: 20,
    paddingTop: 44,
    paddingBottom: 36,
  },
  footerSiteTools: {
    marginTop: 34,
    maxHeight: 0,
    overflow: 'hidden',
    opacity: 0,
  },
  footerLogo: { width: 141, height: 35, tintColor: '#17306f' },
  footerInfo: {
    flex: 1,
    color: '#6d7177',
    fontSize: 14,
    lineHeight: 27,
    fontWeight: '800',
  },
  footerGroups: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 34,
    paddingBottom: 28,
  },
  footerGroup: { flex: 1, gap: 14 },
  footerGroupTitle: {
    color: '#0754d9',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '900',
    letterSpacing: -0.3,
  },
  footerLink: {
    color: '#8a8f96',
    fontSize: 15,
    lineHeight: 25,
    fontWeight: '800',
  },
  footerLegal: {
    minHeight: 116,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#d7dbe1',
    paddingTop: 22,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 44,
  },
  footerBrandColumn: { width: 286 },
  copyright: {
    marginTop: 17,
    color: '#7d8288',
    fontSize: 12,
    fontWeight: '800',
  },
  footerDomainText: {
    marginTop: 7,
    color: '#8f9499',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  privacyLink: {
    width: 150,
    color: '#0754d9',
    fontSize: 15,
    lineHeight: 25,
    fontWeight: '900',
    textAlign: 'right',
  },
  domainRow: { height: 0, marginTop: 0, overflow: 'hidden', opacity: 0 },
  mobileMenuOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 30,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
  },
  mobileMenuPanel: {
    margin: 18,
    maxHeight: '92%',
    borderRadius: 28,
    backgroundColor: colors.white,
    padding: 22,
  },
  mobileCloseButton: {
    alignSelf: 'flex-end',
    minHeight: 34,
    justifyContent: 'center',
  },
  mobileCloseText: { color: colors.ink, fontSize: 14, fontWeight: '900' },
  mobileMenuTitle: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  mobileMenuScroll: { marginTop: 12 },
  mobileMenuGroup: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  mobileMenuGroupTitle: {
    color: colors.blue,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  mobileMenuLink: { paddingVertical: 8 },
  mobileMenuLinkText: { color: colors.ink, fontSize: 17, fontWeight: '800' },
});
