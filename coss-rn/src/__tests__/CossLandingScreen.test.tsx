import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-video', () => {
  const React = require('react');
  const { View } = require('react-native');

  return {
    __esModule: true,
    default: (props: Record<string, unknown>) =>
      React.createElement(View, {
        ...props,
        accessibilityLabel: props.accessibilityLabel ?? 'video',
        accessible: true,
      }),
  };
});

import { CossLandingScreen } from '../CossLandingScreen';
import {
  cossHeroVideo,
  cossPages,
  cossSiteRoutes,
  cossSourceSitemapRoutes,
} from '../cossContent';

describe('CossLandingScreen', () => {
  it('renders the COSS Korea landing hero and service sections', async () => {
    const { getByText, getAllByText } = await render(<CossLandingScreen />);

    expect(getByText('대한민국 대표 아웃소싱 기업 (주) 코스')).toBeTruthy();
    expect(getAllByText('물류도급').length).toBeGreaterThan(1);
    expect(getAllByText('생산도급').length).toBeGreaterThan(1);
    expect(getAllByText('통합시설관리').length).toBeGreaterThan(0);
    expect(getByText('COSS는 고객 곁에서')).toBeTruthy();
  });

  it('uses cosskorea.com and console.cosskorea.com for the migrated domains', async () => {
    const { getByText, queryByText } = await render(<CossLandingScreen />);

    expect(getByText('www.cosskorea.com')).toBeTruthy();
    expect(getByText('console.cosskorea.com')).toBeTruthy();
    expect(queryByText('www.cossok.com')).toBeNull();
  });

  it('copies the source sitemap into selectable React Native pages', async () => {
    const { getByLabelText } = await render(<CossLandingScreen />);
    const copiedRoutes = cossPages.map(page => page.route);

    for (const route of cossSourceSitemapRoutes) {
      expect(copiedRoutes).toContain(route);
    }

    for (const page of cossPages) {
      expect(getByLabelText(`COSS page: ${page.title}`)).toBeTruthy();
    }
  });

  it('includes footer policy routes discovered from the live source site crawl', async () => {
    const { getByLabelText } = await render(<CossLandingScreen />);

    expect(getByLabelText('COSS page: 이용약관')).toBeTruthy();
    expect(getByLabelText('COSS page: 개인정보 취급방침')).toBeTruthy();
    expect(getByLabelText('COSS page: 이메일 무단수집 거부')).toBeTruthy();
    expect(getByLabelText('COSS page: 사이트맵')).toBeTruthy();
  });

  it('locks desktop/mobile scrolling to source fullpage frames', async () => {
    const { getByTestId } = await render(<CossLandingScreen />);
    const parallaxScroll = getByTestId('coss-parallax-scroll');

    expect(parallaxScroll.props.pagingEnabled).toBe(true);
    expect(parallaxScroll.props.disableIntervalMomentum).toBe(true);
    expect(parallaxScroll.props.decelerationRate).toBe('fast');
    expect(parallaxScroll.props.snapToAlignment).toBe('start');
    expect(parallaxScroll.props.showsVerticalScrollIndicator).toBe(false);
    expect(parallaxScroll.props.snapToOffsets).toHaveLength(5);
    expect(parallaxScroll.props.snapToOffsets[0]).toBe(0);
    expect(parallaxScroll.props.snapToOffsets[1]).toBeGreaterThan(0);
    expect(parallaxScroll.props.snapToOffsets[2]).toBe(
      parallaxScroll.props.snapToOffsets[1] * 2,
    );
    expect(parallaxScroll.props.snapToOffsets[3]).toBe(
      parallaxScroll.props.snapToOffsets[1] * 3,
    );
    expect(parallaxScroll.props.snapToOffsets[4]).toBeGreaterThan(
      parallaxScroll.props.snapToOffsets[3],
    );

    expect(getByTestId('fullpage-frame-hero')).toBeTruthy();
    expect(getByTestId('fullpage-frame-business')).toBeTruthy();
    expect(getByTestId('fullpage-frame-sustainability')).toBeTruthy();
    expect(getByTestId('fullpage-frame-contact')).toBeTruthy();
    expect(getByTestId('fullpage-frame-footer')).toBeTruthy();
  });

  it('includes the COSS source video, parallax scroll layer, and motion affordances', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);
    const heroVideo = getByLabelText('COSS source hero video');
    const parallaxScroll = getByTestId('coss-parallax-scroll');

    expect(heroVideo.props.source.uri).toBe(cossHeroVideo.legacyUri);
    expect(cossHeroVideo.targetUri).toBe(
      'https://www.cosskorea.com/html/_skin/files/coss_main_all_251229.mp4?ver=251224',
    );
    expect(typeof parallaxScroll.props.onScroll).toBe('function');
    expect(getByTestId('fixed-video-parallax-layer')).toBeTruthy();
    expect(getByTestId('hero-parallax-copy')).toBeTruthy();
    expect(getByTestId('hero-reveal-motion')).toBeTruthy();
    expect(getByTestId('hero-video-atmosphere')).toBeTruthy();
    expect(getByTestId('recruit-motion-row')).toBeTruthy();
    expect(getByTestId('business-motion-row')).toBeTruthy();

    fireEvent.scroll(parallaxScroll, {
      nativeEvent: { contentOffset: { y: 920 } },
    });
  });

  it('changes hero slides with source-style progress controls', async () => {
    const { getByLabelText, getByTestId, getByText } = await render(
      <CossLandingScreen />,
    );

    fireEvent.press(getByLabelText('Hero progress 03: 생산도급'));

    await waitFor(() => {
      expect(getByTestId('active-hero-title').props.children).toBe('생산도급');
      expect(
        getByText(
          '다양한 제조 현장의 도급 운영 노하우로, 최적의 인력 운영과 공정 효율을 제공합니다.',
        ),
      ).toBeTruthy();
    });
  });

  it('opens the language selector and mobile sitemap menu', async () => {
    const { getByLabelText, getByText, getAllByText, queryByLabelText } =
      await render(<CossLandingScreen />);

    fireEvent.press(getByLabelText('Language selector'));
    await waitFor(() => expect(getByText('KOR')).toBeTruthy());
    expect(getByText('ENG')).toBeTruthy();

    fireEvent.press(getByLabelText('Open COSS mobile menu'));
    await waitFor(() =>
      expect(getByLabelText('Close COSS mobile menu')).toBeTruthy(),
    );
    expect(getAllByText('가치와 비젼').length).toBeGreaterThan(0);
    expect(getAllByText('이메일 무단수집 거부').length).toBeGreaterThan(0);

    fireEvent.press(getByLabelText('Close COSS mobile menu'));
    await waitFor(() =>
      expect(queryByLabelText('Close COSS mobile menu')).toBeNull(),
    );
  });

  it('moves the recruit carousel with the same visible-center-card behavior as the source', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);

    expect(getByTestId('featured-recruit-title').props.children).toContain(
      'KGM 평택공장',
    );
    fireEvent.press(getByLabelText('Recruit next'));
    await waitFor(() =>
      expect(getByTestId('featured-recruit-title').props.children).toContain(
        '건설기계장비',
      ),
    );
    fireEvent.press(getByLabelText('Recruit previous'));
    await waitFor(() =>
      expect(getByTestId('featured-recruit-title').props.children).toContain(
        'KGM 평택공장',
      ),
    );
  });

  it('moves the business carousel and keeps business routes interactive', async () => {
    const { getByLabelText, getByTestId } = await render(<CossLandingScreen />);

    expect(getByTestId('active-business-title').props.children).toBe(
      '생산도급',
    );
    fireEvent.press(getByLabelText('Business next'));
    await waitFor(() =>
      expect(getByTestId('active-business-title').props.children).toBe(
        '물류도급',
      ),
    );
    fireEvent.press(getByLabelText('Business previous'));
    await waitFor(() =>
      expect(getByTestId('active-business-title').props.children).toBe(
        '생산도급',
      ),
    );
  });

  it('maps every fetched cossok.com route to cosskorea.com', async () => {
    const { getAllByText, queryByText } = await render(<CossLandingScreen />);

    for (const route of cossSiteRoutes) {
      expect(getAllByText(`cosskorea.com${route}`).length).toBeGreaterThan(0);
      expect(queryByText(`cossok.com${route}`)).toBeNull();
    }
  });

  it('navigates between full COSS pages from the RN section menu', async () => {
    const { getByLabelText, getByText } = await render(<CossLandingScreen />);

    fireEvent.press(getByLabelText('COSS page: 연혁'));
    await waitFor(() =>
      expect(getByText('“새로운 도약, 미래를 잇다”')).toBeTruthy(),
    );

    fireEvent.press(getByLabelText('COSS page: FAQ'));
    await waitFor(() => expect(getByText('자주 묻는 질문')).toBeTruthy());

    fireEvent.press(getByLabelText('COSS page: 개인정보 취급방침'));
    await waitFor(() =>
      expect(getByText('개인정보 보호 및 권익 보호')).toBeTruthy(),
    );
  });
});
